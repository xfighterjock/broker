import express from "express";
import cookieParser from "cookie-parser";
import {
  DEFAULT_DAILY_LOSS_USD,
  GATED_ROOTS,
  MAX_QTY,
  REDIS_CHANNELS,
  AUTO_PAPER_INTERVAL_MS,
  REDIS_KEYS,
  SLEEVE_IDS,
  TRADER,
  TZ,
} from "../../shared/constants";
import { computeClock } from "../../shared/clock";
import {
  applyPaperPatch,
  applySleevePatch,
  defaultSleeves,
  emptyChecklist,
  emptyFreeze,
  type CalendarEvent,
  type Checklist,
  type FreezeCard,
  type PaperFill,
  type SleeveId,
  type StatusSnapshot,
  type OverlayKind,
} from "../../shared/types";
import {
  MOMENTUM_STOP_MUL,
  OWNERSHIP_STOP_MUL,
  runAutopilot,
  sizeByStopRisk,
  type AutoBuy,
  type AutoSell,
} from "./autopilot";
import {
  authRequired,
  gatePassword,
  isAuthed,
  requireAuth,
} from "./auth";
import type { AppConfig } from "./config";
import type { DbPool } from "./db";
import {
  insertFreeze,
  insertGateLog,
  insertSessionLog,
  latestFreeze,
  loadEvents,
  recentGateLog,
  recentSessionLogs,
  stampKnowledgeTime,
} from "./db";
import { GateEngine } from "./gate";
import { MockBroker } from "./mockBroker";
import type { RedisClient } from "./redis";
import { fetchDelayedQuotes, mapTicker, symbolsForSleeve } from "./quotes";
import { attachScanReady, getScan, getScanFeaturesCache, rankMomentum, rankOwnership } from "./scan";
import {
  allSleeveBooks,
  applyExitStats,
  applySessionPnl,
  closeSideFor,
  detectStopHits,
  lastFromQuotes,
  makeFill,
  oppositeSide,
  parsePaperClose,
  parsePaperOrder,
  positionSideFor,
  rollSessionMarks,
  signedPnl,
  sleeveBook,
  validatePaperOrder,
  type PaperCloseBody,
  type PaperOrderBody,
  type SessionMark,
} from "./paper";
import {
  fetchOptionChain,
  fetchOptionExpiries,
  findLeg,
  parseYmd,
} from "./etrade";
import {
  applyOverlayMarks,
  detectOverlaySettlements,
  isOverlayPosition,
  isWeeklyExpiryType,
  makeOverlayMeta,
  matchingOwnershipLong,
  optionsFreeCash,
  overlayPackageSymbol,
  overlayThesisTag,
  overlayUnrealized,
  parsePaperOverlay,
  validateCoveredCall,
  validateCsp,
} from "./overlay";
import {
  applyVerticalMarks,
  detectVerticalExits,
  isVerticalBody,
  isVerticalPosition,
  makeVerticalMeta,
  parsePaperVertical,
  validateDebitVertical,
  verticalPackageSymbol,
  verticalUnrealized,
} from "./vertical";
import type { StatusHub } from "./wsHub";

let autoPaperTimer: ReturnType<typeof setInterval> | null = null;

export function stopAutoPaperLoop(): void {
  if (autoPaperTimer) {
    clearInterval(autoPaperTimer);
    autoPaperTimer = null;
  }
}

export interface AppDeps {
  cfg: AppConfig;
  pool: DbPool | null;
  redis: RedisClient | null;
  redisPub: RedisClient | null;
  broker: MockBroker;
  engine: GateEngine;
  getEvents: () => CalendarEvent[];
  setEvents: (events: CalendarEvent[]) => void;
  hub: StatusHub;
  brokerName: string;
  brokerMode: "mock" | "demo";
  liveRefused: boolean;
  stubNote: string | null;
}

function freezeFromRow(row: Awaited<ReturnType<typeof latestFreeze>>): {
  freeze: FreezeCard;
  knowledgeTime: string | null;
} {
  if (!row) return { freeze: emptyFreeze(), knowledgeTime: null };
  const consensus = row.consensus;
  const consensusObjects =
    typeof consensus === "string"
      ? consensus
      : consensus && typeof consensus === "object" && "text" in (consensus as object)
        ? String((consensus as { text: unknown }).text)
        : JSON.stringify(consensus ?? "");
  const contracts = (row.contracts ?? {}) as FreezeCard["liquidContracts"];
  return {
    freeze: {
      consensusObjects:
        typeof consensus === "object" && consensus && "text" in (consensus as object)
          ? String((consensus as { text: unknown }).text)
          : typeof consensus === "string"
            ? consensus
            : consensusObjects === "{}"
              ? ""
              : consensusObjects,
      sourceLabel: row.source ?? "",
      fedWatchSnapshot: row.fedwatch ?? "",
      liquidContracts: {
        MES: contracts.MES ?? "",
        ZN: contracts.ZN ?? "",
        M6E: contracts.M6E ?? "",
        SR3: contracts.SR3 ?? "",
      },
      freezeTimestamp: row.frozenAt,
    },
    knowledgeTime: row.knowledgeTime,
  };
}

export function buildApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.use(cookieParser());

  const memory = {
    freeze: emptyFreeze(),
    knowledgeTime: null as string | null,
    checklist: emptyChecklist(),
    sessionLog: [] as { ts: string; kind: string; message: string }[],
    sleeves: defaultSleeves(),
    activeSleeve: "day" as SleeveId,
    sleevesHydrated: false,
    blotter: [] as PaperFill[],
    blotterHydrated: false,
    autoPaper: true,
    autoPaperHydrated: false,
    sessionMarks: {
      day: null,
      momentum: null,
      options: null,
      ownership: null,
    } as Record<SleeveId, SessionMark | null>,
    sessionMarksHydrated: false,
  };

  async function ensureSleeves(): Promise<void> {
    if (memory.sleevesHydrated) return;
    memory.sleevesHydrated = true;
    if (!deps.redis) return;
    try {
      const raw = await deps.redis.get(REDIS_KEYS.sleeves);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const base = defaultSleeves();
      for (const id of SLEEVE_IDS) {
        const row = parsed[id];
        if (row && typeof row === "object") {
          const patched = applySleevePatch(base[id], row as Record<string, unknown>);
          const storedAt = (row as { updatedAt?: unknown }).updatedAt;
          patched.updatedAt = typeof storedAt === "string" ? storedAt : null;
          patched.id = id;
          patched.name = base[id].name;
          base[id] = patched;
        }
      }
      memory.sleeves = base;
    } catch {
      /* keep defaults */
    }
  }

  async function persistSleeves(): Promise<void> {
    if (!deps.redis) return;
    try {
      await deps.redis.set(REDIS_KEYS.sleeves, JSON.stringify(memory.sleeves));
    } catch {
      /* ignore */
    }
  }

  async function ensureBlotter(): Promise<void> {
    if (memory.blotterHydrated) return;
    memory.blotterHydrated = true;
    if (!deps.redis) return;
    try {
      const raw = await deps.redis.get(REDIS_KEYS.blotter);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return;
      const fills: PaperFill[] = [];
      for (const row of parsed) {
        if (!row || typeof row !== "object") continue;
        const f = row as Partial<PaperFill>;
        if (
          typeof f.id !== "string" ||
          typeof f.sleeveId !== "string" ||
          !(SLEEVE_IDS as readonly string[]).includes(f.sleeveId) ||
          typeof f.ts !== "string" ||
          typeof f.symbol !== "string" ||
          (f.side !== "Buy" && f.side !== "Sell") ||
          typeof f.qty !== "number" ||
          !Number.isFinite(f.qty) ||
          typeof f.price !== "number" ||
          !Number.isFinite(f.price) ||
          typeof f.notes !== "string"
        ) {
          continue;
        }
        fills.push({
          id: f.id,
          sleeveId: f.sleeveId as SleeveId,
          ts: f.ts,
          symbol: f.symbol,
          side: f.side,
          qty: f.qty,
          price: f.price,
          notes: f.notes,
        });
      }
      memory.blotter = fills.slice(-200);
    } catch {
      /* keep empty */
    }
  }

  async function persistBlotter(): Promise<void> {
    if (!deps.redis) return;
    try {
      await deps.redis.set(REDIS_KEYS.blotter, JSON.stringify(memory.blotter));
    } catch {
      /* ignore */
    }
  }

  async function ensureAutoPaper(): Promise<void> {
    if (memory.autoPaperHydrated) return;
    memory.autoPaperHydrated = true;
    if (!deps.redis) return;
    try {
      const raw = await deps.redis.get(REDIS_KEYS.autoPaper);
      if (raw === "0") memory.autoPaper = false;
      else if (raw === "1") memory.autoPaper = true;
    } catch {
      /* default enabled */
    }
  }

  async function persistAutoPaper(): Promise<void> {
    if (!deps.redis) return;
    try {
      await deps.redis.set(REDIS_KEYS.autoPaper, memory.autoPaper ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  async function ensureSessionMarks(): Promise<void> {
    if (memory.sessionMarksHydrated) return;
    memory.sessionMarksHydrated = true;
    if (!deps.redis) return;
    try {
      const raw = await deps.redis.get(REDIS_KEYS.sessionMarks);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const id of SLEEVE_IDS) {
        const row = parsed[id];
        if (!row || typeof row !== "object") continue;
        const r = row as { sessionDate?: unknown; realizedPnlUsd?: unknown; unrealizedPnlUsd?: unknown };
        if (typeof r.sessionDate !== "string") continue;
        const realized = Number(r.realizedPnlUsd);
        const unrealized = Number(r.unrealizedPnlUsd);
        if (!Number.isFinite(realized) || !Number.isFinite(unrealized)) continue;
        memory.sessionMarks[id] = {
          sessionDate: r.sessionDate,
          realizedPnlUsd: realized,
          unrealizedPnlUsd: unrealized,
        };
      }
    } catch {
      /* keep defaults */
    }
  }

  async function persistSessionMarks(): Promise<void> {
    if (!deps.redis) return;
    try {
      await deps.redis.set(REDIS_KEYS.sessionMarks, JSON.stringify(memory.sessionMarks));
    } catch {
      /* ignore */
    }
  }

  async function persistLog(line: string, ts: string): Promise<void> {
    if (deps.pool) {
      try {
        await insertGateLog(deps.pool, ts, line);
      } catch (err) {
        console.error("[EventGate] gate_log insert failed", err);
      }
    }
    if (deps.redisPub) {
      try {
        await deps.redisPub.publish(
          REDIS_CHANNELS.log,
          JSON.stringify({ ts, line }),
        );
      } catch {
        /* ignore */
      }
    }
    deps.hub.broadcast({ type: "log", ts, line });
  }

  deps.engine.onLog = (line, ts) => {
    void persistLog(line, ts);
  };

  function sessionNote(kind: string, message: string): void {
    const entry = { ts: new Date().toISOString(), kind, message };
    memory.sessionLog.push(entry);
    if (memory.sessionLog.length > 500) {
      memory.sessionLog.splice(0, memory.sessionLog.length - 500);
    }
    if (deps.pool) {
      void insertSessionLog(deps.pool, kind, memory.checklist, message);
    }
  }

  function assertMockOnly(): string | null {
    if (
      deps.broker.mode !== "mock" ||
      typeof deps.broker.injectOrder !== "function" ||
      typeof deps.broker.injectPosition !== "function"
    ) {
      return "paper orders are MockBroker only — live/demo Tradovate refused";
    }
    return null;
  }

  function matchSym(a: string, b: string): boolean {
    const am = (mapTicker(a) ?? a).toUpperCase();
    const bm = (mapTicker(b) ?? b).toUpperCase();
    return am === bm || a.toUpperCase() === b.toUpperCase();
  }

  async function recordPaperExit(opts: {
    sleeveId: SleeveId;
    symbol: string;
    side: "Buy" | "Sell";
    qty: number;
    price: number;
    notes: string;
    realizedPnl: number;
  }): Promise<void> {
    await ensureSleeves();
    await ensureBlotter();
    const fill = makeFill({
      sleeveId: opts.sleeveId,
      symbol: opts.symbol,
      side: opts.side,
      qty: opts.qty,
      price: opts.price,
      notes: opts.notes,
    });
    memory.blotter.push(fill);
    if (memory.blotter.length > 200) {
      memory.blotter.splice(0, memory.blotter.length - 200);
    }
    const card = memory.sleeves[opts.sleeveId];
    memory.sleeves[opts.sleeveId] = {
      ...card,
      paper: applyExitStats(card.paper, opts.realizedPnl),
      updatedAt: new Date().toISOString(),
    };
    deps.broker.addRealizedPnl(opts.realizedPnl);
    await persistBlotter();
    await persistSleeves();
    sessionNote(
      "paper_fill",
      `${opts.sleeveId} ${opts.side} ${opts.qty} ${opts.symbol} @ ${opts.price} (${opts.notes})`,
    );
    deps.engine.log(
      `paper fill ${fill.id} ${opts.side} ${opts.qty} ${opts.symbol} @ ${opts.price} pnl ${opts.realizedPnl.toFixed(2)} (MockBroker, not Tradovate)`,
    );
  }

  async function markPaperQuiet(): Promise<number> {
    const positions = deps.broker
      .getPositionsSync()
      .filter((p) => p.side !== "Flat" && p.qty > 0);
    const orders = deps.broker.getOrdersSync();
    const live = new Set(["Working", "Submitted", "Accepted"]);
    const stopSyms = orders
      .filter((o) => live.has(o.state) && (o.type === "StopMarket" || o.type === "StopLimit"))
      .map((o) => o.symbol);
    const symbols = [...new Set([...positions.map((p) => p.symbol), ...stopSyms])];
    if (symbols.length === 0) return 0;
    const quotes = await fetchDelayedQuotes(symbols);
    const hits = detectStopHits(positions, orders, quotes);
    for (const hit of hits) {
      const sleeveId = hit.position.sleeveId ?? hit.stop.sleeveId ?? "momentum";
      await deps.broker.cancelOrders([hit.stop.id], "paper stop hit");
      await deps.broker.flattenSymbols([hit.position.symbol], "paper stop hit");
      await recordPaperExit({
        sleeveId,
        symbol: hit.position.symbol,
        side: closeSideFor(hit.position.side),
        qty: hit.position.qty,
        price: hit.last,
        notes: "stop hit",
        realizedPnl: hit.realizedPnl,
      });
      deps.engine.log(
        `paper STOP HIT ${hit.position.symbol} ${hit.position.side} qty ${hit.position.qty} last ${hit.last} stop ${hit.stop.stopPrice} (MockBroker flatten, not live)`,
      );
    }
    const still = deps.broker.getPositionsSync().filter((p) => p.side !== "Flat" && p.qty > 0);
    for (const p of still) {
      if (isVerticalPosition(p) || isOverlayPosition(p)) continue;
      const last = lastFromQuotes(quotes, p.symbol);
      if (last === null) continue;
      deps.broker.setUnrealizedPnl(p.symbol, signedPnl(p.side, p.avgPrice, last, p.qty, p.symbol));
    }
    const vHits = await markVerticalsQuiet();
    const oHits = await markOverlaysQuiet();
    return hits.length + vHits + oHits;
  }

  async function markVerticalsQuiet(): Promise<number> {
    const open = deps.broker
      .getPositionsSync()
      .filter((p) => p.side !== "Flat" && p.qty > 0 && isVerticalPosition(p));
    if (open.length === 0) return 0;
    const groups = new Map<string, { underlying: string; expiry: string }>();
    for (const p of open) {
      const v = p.vertical!;
      const key = `${v.quoteSymbol || v.underlying}|${v.expiry}`;
      if (!groups.has(key)) groups.set(key, { underlying: v.quoteSymbol || v.underlying, expiry: v.expiry });
    }
    const chains = new Map<string, Awaited<ReturnType<typeof fetchOptionChain>>>();
    for (const [key, g] of groups) {
      try {
        const ymd = parseYmd(g.expiry);
        if (!ymd) continue;
        const chain = await fetchOptionChain({
          symbol: g.underlying,
          expiryYear: ymd.year,
          expiryMonth: ymd.month,
          expiryDay: ymd.day,
        });
        chains.set(key, chain);
      } catch (err) {
        deps.engine.log(
          `options chain mark skip ${g.underlying} ${g.expiry}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    for (const p of open) {
      const v = p.vertical!;
      const key = `${v.quoteSymbol || v.underlying}|${v.expiry}`;
      const chain = chains.get(key);
      if (!chain || !chain.ok) continue;
      const long = findLeg(chain.data.legs, { osiKey: v.long.osiKey, strike: v.long.strike, right: v.right, expiry: v.expiry }) ?? v.long;
      const short = findLeg(chain.data.legs, { osiKey: v.short.osiKey, strike: v.short.strike, right: v.right, expiry: v.expiry }) ?? v.short;
      const next = applyVerticalMarks(v, long, short);
      const u = verticalUnrealized(next, next.long, next.short);
      deps.broker.patchPosition(p.symbol, {
        vertical: next,
        unrealizedPnl: u === null ? p.unrealizedPnl : u,
      });
    }
    const marked = deps.broker
      .getPositionsSync()
      .filter((p) => p.side !== "Flat" && p.qty > 0 && isVerticalPosition(p));
    const exits = detectVerticalExits(marked);
    for (const hit of exits) {
      const pos = hit.position;
      const v = pos.vertical!;
      await deps.broker.flattenSymbols([pos.symbol], hit.reason);
      await recordPaperExit({
        sleeveId: pos.sleeveId ?? "options",
        symbol: pos.symbol,
        side: "Sell",
        qty: v.qty,
        price: hit.closeValue / (v.qty * 100) + v.netDebitPerShare,
        notes: `vertical exit ${hit.reason}`,
        realizedPnl: hit.realizedPnl,
      });
      deps.engine.log(
        `paper VERTICAL EXIT ${pos.symbol} ${hit.reason} pnl ${hit.realizedPnl.toFixed(2)} (MockBroker flatten, not live, not E*TRADE order)`,
      );
    }
    return exits.length;
  }

  async function markOverlaysQuiet(): Promise<number> {
    const open = deps.broker
      .getPositionsSync()
      .filter((p) => p.side !== "Flat" && p.qty > 0 && isOverlayPosition(p));
    if (open.length === 0) return 0;
    const groups = new Map<string, { underlying: string; expiry: string }>();
    for (const p of open) {
      const o = p.overlay!;
      const key = `${o.quoteSymbol || o.underlying}|${o.expiry}`;
      if (!groups.has(key)) groups.set(key, { underlying: o.quoteSymbol || o.underlying, expiry: o.expiry });
    }
    const chains = new Map<string, Awaited<ReturnType<typeof fetchOptionChain>>>();
    for (const [key, g] of groups) {
      try {
        const ymd = parseYmd(g.expiry);
        if (!ymd) continue;
        const chain = await fetchOptionChain({
          symbol: g.underlying,
          expiryYear: ymd.year,
          expiryMonth: ymd.month,
          expiryDay: ymd.day,
        });
        chains.set(key, chain);
      } catch (err) {
        deps.engine.log(
          `overlay chain mark skip ${g.underlying} ${g.expiry}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    for (const p of open) {
      const o = p.overlay!;
      const key = `${o.quoteSymbol || o.underlying}|${o.expiry}`;
      const chain = chains.get(key);
      if (!chain || !chain.ok) continue;
      const leg =
        findLeg(chain.data.legs, {
          osiKey: o.leg.osiKey,
          strike: o.strike,
          right: o.right,
          expiry: o.expiry,
        }) ?? o.leg;
      const next = applyOverlayMarks(o, leg);
      const u = overlayUnrealized(next, next.leg);
      deps.broker.patchPosition(p.symbol, {
        overlay: next,
        unrealizedPnl: u === null ? p.unrealizedPnl : u,
      });
    }
    const marked = deps.broker
      .getPositionsSync()
      .filter((p) => p.side !== "Flat" && p.qty > 0 && isOverlayPosition(p));
    const underlyers = [
      ...new Set(
        marked.flatMap((p) => {
          const o = p.overlay!;
          return [o.underlying, o.quoteSymbol, o.thesisSymbol];
        }),
      ),
    ];
    const quotes = underlyers.length ? await fetchDelayedQuotes(underlyers).catch(() => []) : [];
    const lastBy: Record<string, number> = {};
    for (const q of quotes) {
      if (q.last !== null && Number.isFinite(q.last)) lastBy[q.symbol.toUpperCase()] = q.last;
    }
    const exits = detectOverlaySettlements(marked, lastBy);
    for (const hit of exits) {
      const pos = hit.position;
      const o = pos.overlay!;
      await deps.broker.flattenSymbols([pos.symbol], hit.reason);
      await recordPaperExit({
        sleeveId: "options",
        symbol: pos.symbol,
        side: "Buy",
        qty: o.qty,
        price: o.premiumPerShare,
        notes: `${overlayThesisTag(o)} ${hit.reason}`,
        realizedPnl: hit.optionsRealizedPnl,
      });
      if (hit.stockTransfer?.action === "assign") {
        const t = hit.stockTransfer;
        deps.broker.mergeLongStock({
          symbol: t.symbol,
          qty: t.qty,
          side: "Long",
          avgPrice: t.price,
          unrealizedPnl: 0,
          sleeveId: "ownership",
        });
        sessionNote(
          "paper_fill",
          `ownership assigned ${t.qty} ${t.symbol} @ ${t.price} (CSP, MockBroker)`,
        );
        deps.engine.log(
          `paper CSP ASSIGN ${t.qty} ${t.symbol} @ ${t.price} (stock to ownership, MockBroker, not live, not E*TRADE order)`,
        );
      } else if (hit.stockTransfer?.action === "callaway") {
        const t = hit.stockTransfer;
        const stock = matchingOwnershipLong(deps.broker.getPositionsSync(), [t.symbol, o.underlying, o.quoteSymbol]);
        const cost = stock?.avgPrice ?? t.price;
        const stockPnl = (t.price - cost) * t.qty;
        deps.broker.reduceLongStock("ownership", stock?.symbol ?? t.symbol, t.qty);
        await recordPaperExit({
          sleeveId: "ownership",
          symbol: stock?.symbol ?? t.symbol,
          side: "Sell",
          qty: t.qty,
          price: t.price,
          notes: `called away ${overlayThesisTag(o)}`,
          realizedPnl: stockPnl,
        });
        deps.engine.log(
          `paper CC CALLED AWAY ${t.qty} ${t.symbol} @ ${t.price} (MockBroker, not live, not E*TRADE order)`,
        );
      } else {
        deps.engine.log(
          `paper OVERLAY EXIT ${pos.symbol} ${hit.reason} pnl ${hit.optionsRealizedPnl.toFixed(2)} (MockBroker, not live, not E*TRADE order)`,
        );
      }
    }
    return exits.length;
  }

  async function placePaperOverlay(
    kind: OverlayKind,
    body: unknown,
  ): Promise<{ ok: true; symbol: string } | { ok: false; error: string; status?: number }> {
    const mockErr = assertMockOnly();
    if (mockErr) return { ok: false, error: mockErr, status: 403 };
    const parsed = parsePaperOverlay(kind, body);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    const ymd = parseYmd(parsed.expiry);
    if (!ymd) return { ok: false, error: "expiry must be YYYY-MM-DD" };
    if (!parsed.allowWeekly) {
      const expiries = await fetchOptionExpiries(parsed.symbol);
      if (expiries.ok) {
        const row = expiries.data.expiries.find((e) => e.expiry === parsed.expiry);
        if (row && isWeeklyExpiryType(row.expiryType)) {
          return { ok: false, error: "weeklies skipped in defaults" };
        }
      }
    }
    const chain = await fetchOptionChain({
      symbol: parsed.symbol,
      expiryYear: ymd.year,
      expiryMonth: ymd.month,
      expiryDay: ymd.day,
    });
    if (!chain.ok) return { ok: false, error: chain.error, status: chain.status };
    const right = kind === "csp" ? "P" : "C";
    const leg = findLeg(chain.data.legs, {
      strike: parsed.strike,
      right,
      expiry: chain.data.expiry || parsed.expiry,
    });
    if (!leg) return { ok: false, error: `${right === "P" ? "put" : "call"} strike not on chain` };
    await ensureSleeves();
    const quotes = await fetchDelayedQuotes([parsed.symbol, leg.underlying, parsed.thesisSymbol]).catch(() => []);
    const book = sleeveBook(memory.sleeves.options, deps.broker.getPositionsSync(), quotes);
    let v;
    if (kind === "csp") {
      const free = optionsFreeCash(book.equityUsd, deps.broker.getPositionsSync());
      v = validateCsp(
        {
          leg,
          qty: parsed.qty,
          asOf: parsed.asOf,
          quoteSymbol: parsed.symbol,
          thesisSleeve: parsed.thesisSleeve,
          thesisSymbol: parsed.thesisSymbol,
          taLevel: parsed.taLevel,
        },
        free,
      );
    } else {
      const stock = matchingOwnershipLong(deps.broker.getPositionsSync(), [
        parsed.thesisSymbol,
        parsed.symbol,
        leg.underlying,
      ]);
      v = validateCoveredCall({
        leg,
        qty: parsed.qty,
        asOf: parsed.asOf,
        quoteSymbol: parsed.symbol,
        thesisSleeve: parsed.thesisSleeve,
        thesisSymbol: parsed.thesisSymbol,
        taLevel: parsed.taLevel,
        stock,
      });
    }
    if (!v.ok) return { ok: false, error: v.error };
    const pkg = overlayPackageSymbol({
      kind: v.kind,
      underlying: v.underlying,
      strike: v.strike,
      expiry: v.expiry,
    });
    const already = deps.broker
      .getPositionsSync()
      .find((p) => p.side !== "Flat" && p.qty > 0 && p.symbol.toUpperCase() === pkg.toUpperCase());
    if (already) return { ok: false, error: `already open ${already.symbol}` };
    const meta = makeOverlayMeta(v);
    deps.broker.injectPosition({
      symbol: pkg,
      qty: v.qty,
      side: "Short",
      avgPrice: v.premiumPerShare,
      unrealizedPnl: 0,
      sleeveId: "options",
      overlay: meta,
    });
    await ensureBlotter();
    const tag = overlayThesisTag(meta);
    const notes = parsed.thesis || tag;
    const fill = makeFill({
      sleeveId: "options",
      symbol: v.leg.osiKey || v.leg.displaySymbol,
      side: "Sell",
      qty: v.qty,
      price: v.premiumPerShare,
      notes: `${tag} ${notes}`.trim(),
    });
    memory.blotter.push(fill);
    if (memory.blotter.length > 200) {
      memory.blotter.splice(0, memory.blotter.length - 200);
    }
    await persistBlotter();
    sessionNote(
      "paper_order",
      `options ${v.kind} ${v.qty}x ${pkg} premium ${v.premiumReceived.toFixed(2)} ${tag}`,
    );
    deps.engine.log(
      `paper ${v.kind.toUpperCase()} SELL ${v.qty} ${pkg} @ ${v.premiumPerShare} ${tag} (MockBroker, not E*TRADE order, not Tradovate, not live)`,
    );
    return { ok: true, symbol: pkg };
  }

  async function placePaperVertical
(
    body: unknown,
  ): Promise<{ ok: true; symbol: string } | { ok: false; error: string; status?: number }> {
    const mockErr = assertMockOnly();
    if (mockErr) return { ok: false, error: mockErr, status: 403 };
    const parsed = parsePaperVertical(body);
    if ("error" in parsed) return { ok: false, error: parsed.error };
    const ymd = parseYmd(parsed.expiry);
    if (!ymd) return { ok: false, error: "expiry must be YYYY-MM-DD" };
    const chain = await fetchOptionChain({
      symbol: parsed.symbol,
      expiryYear: ymd.year,
      expiryMonth: ymd.month,
      expiryDay: ymd.day,
    });
    if (!chain.ok) return { ok: false, error: chain.error, status: chain.status };
    const long =
      findLeg(chain.data.legs, {
        osiKey: parsed.longOsiKey,
        strike: parsed.longStrike,
        right: parsed.right,
        expiry: chain.data.expiry || parsed.expiry,
      }) ??
      findLeg(chain.data.legs, { strike: parsed.longStrike, right: parsed.right });
    const short =
      findLeg(chain.data.legs, {
        osiKey: parsed.shortOsiKey,
        strike: parsed.shortStrike,
        right: parsed.right,
        expiry: chain.data.expiry || parsed.expiry,
      }) ??
      findLeg(chain.data.legs, { strike: parsed.shortStrike, right: parsed.right });
    if (!long || !short) return { ok: false, error: "long/short strikes not on chain" };
    await ensureSleeves();
    const quotes = await fetchDelayedQuotes([parsed.symbol]).catch(() => []);
    const book = sleeveBook(
      memory.sleeves.options,
      deps.broker.getPositionsSync(),
      quotes,
    );
    const v = validateDebitVertical(
      { long, short, qty: parsed.qty, asOf: parsed.asOf, quoteSymbol: parsed.symbol },
      book.equityUsd,
    );
    if (!v.ok) return { ok: false, error: v.error };
    const pkg = verticalPackageSymbol({
      underlying: v.long.underlying,
      expiry: v.expiry,
      right: v.right,
      longStrike: v.long.strike,
      shortStrike: v.short.strike,
    });
    const already = deps.broker
      .getPositionsSync()
      .find((p) => p.side !== "Flat" && p.qty > 0 && p.symbol.toUpperCase() === pkg.toUpperCase());
    if (already) return { ok: false, error: `already open ${already.symbol}` };
    const meta = makeVerticalMeta(v);
    deps.broker.injectPosition({
      symbol: pkg,
      qty: v.qty,
      side: "Long",
      avgPrice: v.netDebitPerShare,
      unrealizedPnl: 0,
      sleeveId: "options",
      vertical: meta,
    });
    await ensureBlotter();
    const notes = parsed.thesis || `debit ${v.right} ${v.long.strike}/${v.short.strike} ${v.expiry}`;
    const longFill = makeFill({
      sleeveId: "options",
      symbol: v.long.osiKey || v.long.displaySymbol,
      side: "Buy",
      qty: v.qty,
      price: v.longFill,
      notes: `vertical long ${notes}`,
    });
    const shortFill = makeFill({
      sleeveId: "options",
      symbol: v.short.osiKey || v.short.displaySymbol,
      side: "Sell",
      qty: v.qty,
      price: v.shortFill,
      notes: `vertical short ${notes}`,
    });
    memory.blotter.push(longFill, shortFill);
    if (memory.blotter.length > 200) {
      memory.blotter.splice(0, memory.blotter.length - 200);
    }
    await persistBlotter();
    sessionNote(
      "paper_order",
      `options debit vertical ${v.qty}x ${pkg} debit ${v.netDebitPaid.toFixed(2)} maxLoss ${v.maxLoss.toFixed(2)} maxProfit ${v.maxProfit.toFixed(2)}`,
    );
    deps.engine.log(
      `paper VERTICAL BUY ${v.qty} ${pkg} long @ ${v.longFill} short @ ${v.shortFill} debit ${v.netDebitPaid.toFixed(2)} (MockBroker, not E*TRADE order, not Tradovate, not live)`,
    );
    return { ok: true, symbol: pkg };
  }

  async function placePaperOrder(
    parsed: PaperOrderBody,
  ): Promise<{ ok: true; mapped: string; last: number } | { ok: false; error: string }> {
    const mockErr = assertMockOnly();
    if (mockErr) return { ok: false, error: mockErr };
    const quotes = await fetchDelayedQuotes([parsed.symbol]);
    const last = lastFromQuotes(quotes, parsed.symbol);
    if (last === null) return { ok: false, error: "no delayed last" };
    await ensureSleeves();
    const clock = computeClock(new Date(), deps.getEvents());
    const v = validatePaperOrder(parsed, {
      last,
      gateMode: clock.mode,
      dailyLossUsd: deps.engine.dailyLossUsd,
      dayPnl: deps.broker.getDayPnl(),
      sleeveRealizedPnl: memory.sleeves[parsed.sleeveId].paper.realizedPnlUsd,
    });
    if (!v.ok) return { ok: false, error: v.error };
    const open = deps.broker
      .getPositionsSync()
      .find((p) => p.side !== "Flat" && p.qty > 0 && matchSym(p.symbol, v.mapped));
    if (open) return { ok: false, error: `already open ${open.symbol}` };
    if (v.warn) {
      deps.engine.log(`paper risk note ${v.mapped}: ${v.warn}`);
    }
    deps.broker.injectPosition({
      symbol: v.mapped,
      qty: parsed.qty,
      side: positionSideFor(parsed.side),
      avgPrice: last,
      unrealizedPnl: 0,
      sleeveId: parsed.sleeveId,
    });
    const stop = deps.broker.injectOrder({
      symbol: v.mapped,
      type: "StopMarket",
      side: oppositeSide(parsed.side),
      qty: parsed.qty,
      stopPrice: parsed.stopPrice,
      sleeveId: parsed.sleeveId,
    });
    await ensureBlotter();
    const fill = makeFill({
      sleeveId: parsed.sleeveId,
      symbol: v.mapped,
      side: parsed.side,
      qty: parsed.qty,
      price: last,
      notes: parsed.thesis,
    });
    memory.blotter.push(fill);
    if (memory.blotter.length > 200) {
      memory.blotter.splice(0, memory.blotter.length - 200);
    }
    await persistBlotter();
    sessionNote(
      "paper_order",
      `${parsed.sleeveId} ${parsed.side} ${parsed.qty} ${v.mapped} @ ${last} stop ${parsed.stopPrice}`,
    );
    deps.engine.log(
      `paper ${parsed.side} ${parsed.qty} ${v.mapped} @ ${last} stop ${stop.stopPrice} ${stop.side} StopMarket (MockBroker, not Tradovate, not live)`,
    );
    return { ok: true, mapped: v.mapped, last };
  }

  async function closePaperPosition(
    parsed: PaperCloseBody,
  ): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
    const mockErr = assertMockOnly();
    if (mockErr) return { ok: false, error: mockErr };
    const mapped = mapTicker(parsed.symbol) ?? parsed.symbol;
    const pos = deps.broker.getPositionsSync().find(
      (p) =>
        p.side !== "Flat" &&
        p.qty > 0 &&
        matchSym(p.symbol, mapped) &&
        (p.sleeveId === parsed.sleeveId || p.sleeveId === undefined),
    );
    if (!pos) return { ok: false, error: "no open paper position", status: 404 };
    let last: number;
    let pnl: number;
    let notesPrice: number;
    if (isVerticalPosition(pos) && pos.vertical) {
      const u = verticalUnrealized(pos.vertical, pos.vertical.long, pos.vertical.short);
      pnl = u === null ? pos.unrealizedPnl : u;
      last = pos.vertical.netDebitPerShare;
      notesPrice = pos.vertical.netDebitPerShare;
    } else if (isOverlayPosition(pos) && pos.overlay) {
      const u = overlayUnrealized(pos.overlay, pos.overlay.leg);
      pnl = u === null ? pos.unrealizedPnl : u;
      last = pos.overlay.premiumPerShare;
      notesPrice = pos.overlay.premiumPerShare;
    } else {
      const quotes = await fetchDelayedQuotes([pos.symbol]);
      const qlast = lastFromQuotes(quotes, pos.symbol);
      if (qlast === null) return { ok: false, error: "no delayed last" };
      last = qlast;
      notesPrice = last;
      pnl = signedPnl(pos.side, pos.avgPrice, last, pos.qty, pos.symbol);
    }
    const live = new Set(["Working", "Submitted", "Accepted"]);
    const working = deps.broker
      .getOrdersSync()
      .filter((o) => live.has(o.state) && matchSym(o.symbol, pos.symbol));
    if (working.length) {
      await deps.broker.cancelOrders(
        working.map((o) => o.id),
        `paper close ${parsed.reason}`,
      );
    }
    await deps.broker.flattenSymbols([pos.symbol], parsed.reason);
    await recordPaperExit({
      sleeveId: parsed.sleeveId,
      symbol: pos.symbol,
      side: closeSideFor(pos.side),
      qty: pos.qty,
      price: notesPrice,
      notes: parsed.reason,
      realizedPnl: pnl,
    });
    return { ok: true };
  }

  let autoRunning = false;
  async function runWiredAutopilot(): Promise<void> {
    if (autoRunning) return;
    autoRunning = true;
    try {
      await ensureAutoPaper();
      await ensureSleeves();
      if (!memory.autoPaper) return;
      const mockErr = assertMockOnly();
      if (mockErr) {
        deps.engine.log(`auto paper idle: ${mockErr}`);
        return;
      }
      const cache = getScanFeaturesCache();
      const scanReady = cache !== null;
      const momentumRows = cache
        ? rankMomentum(cache.rows, cache.spyRet63, cache.spyRet252)
        : [];
      const ownershipRows = cache ? rankOwnership(cache.rows, cache.spyRet63) : [];
      const featureRows = cache
        ? cache.rows.map((r) => ({ symbol: r.symbol, above200: r.features.above200 }))
        : [];
      await runAutopilot({
        enabled: memory.autoPaper,
        getPositions: () => deps.broker.getPositionsSync(),
        getSleeves: () => memory.sleeves,
        momentumRows,
        ownershipRows,
        featureRows,
        scanReady,
        place: async (buy: AutoBuy) => {
          const quotes = await fetchDelayedQuotes([buy.symbol]);
          const last = lastFromQuotes(quotes, buy.symbol);
          if (last === null) return { ok: false, error: "no delayed last" };
          const mul = buy.sleeveId === "momentum" ? MOMENTUM_STOP_MUL : OWNERSHIP_STOP_MUL;
          const stopPrice = last * mul;
          const book = sleeveBook(
            memory.sleeves[buy.sleeveId],
            deps.broker.getPositionsSync(),
            quotes,
          );
          const qty = sizeByStopRisk(last, stopPrice, buy.symbol, book.equityUsd);
          return placePaperOrder({
            sleeveId: buy.sleeveId,
            symbol: buy.symbol,
            side: "Buy",
            qty,
            stopPrice,
            thesis: buy.thesis,
          });
        },
        close: async (sell: AutoSell) => closePaperPosition(sell),
        log: (line) => deps.engine.log(line),
      });
    } catch (err) {
      deps.engine.log(
        `auto paper error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      autoRunning = false;
    }
  }

  async function sleeveBooksWithSession() {
    await ensureSessionMarks();
    const raw = allSleeveBooks(memory.sleeves, deps.broker.getPositionsSync());
    memory.sessionMarks = rollSessionMarks(raw, memory.sessionMarks);
    await persistSessionMarks();
    const out = {} as typeof raw;
    for (const id of SLEEVE_IDS) {
      out[id] = applySessionPnl(raw[id], memory.sessionMarks[id]);
    }
    return out;
  }

  async function snapshot(): Promise<StatusSnapshot> {
    const now = new Date();
    const events = deps.getEvents();
    const clock = computeClock(now, events);
    await markPaperQuiet();
    await ensureSleeves();
    await ensureBlotter();
    await ensureAutoPaper();
    let freeze = memory.freeze;
    let knowledgeTime = memory.knowledgeTime;
    if (deps.pool) {
      try {
        const row = await latestFreeze(deps.pool);
        const parsed = freezeFromRow(row);
        freeze = parsed.freeze;
        knowledgeTime = parsed.knowledgeTime;
        memory.freeze = freeze;
        memory.knowledgeTime = knowledgeTime;
      } catch {
        /* keep memory */
      }
    }
    let actionLog = deps.engine.getLogs();
    let sessionLog = memory.sessionLog;
    if (deps.pool) {
      try {
        const [g, s] = await Promise.all([
          recentGateLog(deps.pool, 200),
          recentSessionLogs(deps.pool, 200),
        ]);
        if (g.length) actionLog = g;
        if (s.length) sessionLog = s;
      } catch {
        /* keep memory */
      }
    }
    return {
      trader: TRADER,
      tz: TZ,
      clock,
      events,
      freeze,
      knowledgeTime,
      checklist: memory.checklist,
      sessionLog,
      actionLog,
      gateEnabled: deps.engine.enabled,
      dailyLossUsd: deps.engine.dailyLossUsd,
      qtyCap: MAX_QTY,
      gatedRoots: GATED_ROOTS,
      authRequired: authRequired(),
      broker: {
        name: deps.brokerName,
        mode: deps.brokerMode,
        liveRefused: deps.liveRefused,
        stubNote: deps.stubNote,
        orders: deps.broker.getOrdersSync(),
        positions: deps.broker.getPositionsSync(),
        dayPnl: deps.broker.getDayPnl(),
        account: "SIMULATION",
      },
      sleeves: memory.sleeves,
      activeSleeve: memory.activeSleeve,
      paperBlotter: memory.blotter.slice(-200),
      autoPaper: memory.autoPaper,
      sleeveBooks: await sleeveBooksWithSession(),
    };
  }

  async function publishStatus(): Promise<void> {
    const snap = await snapshot();
    if (deps.redisPub) {
      try {
        await deps.redisPub.publish(REDIS_CHANNELS.status, JSON.stringify(snap));
      } catch {
        /* ignore */
      }
    }
    deps.hub.broadcast({ type: "status", payload: snap });
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, authRequired: authRequired() });
  });

  app.get("/api/auth/status", (req, res) => {
    res.json({ authRequired: authRequired(), authed: isAuthed(req) });
  });

  app.post("/api/auth/login", (req, res) => {
    const password = String(req.body?.password ?? "");
    const expected = gatePassword();
    if (!expected) {
      res.json({ ok: true, authRequired: false });
      return;
    }
    if (password !== expected) {
      res.status(401).json({ error: "bad password" });
      return;
    }
    req.session.authed = true;
    req.session.save((err) => {
      if (err) {
        res.status(500).json({ error: "session save failed" });
        return;
      }
      res.json({ ok: true });
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("eg.sid", { path: "/" });
      res.json({ ok: true });
    });
  });

  app.use("/api", (req, res, next) => {
    if (
      req.path === "/health" ||
      req.path === "/auth/status" ||
      req.path === "/auth/login" ||
      req.path === "/auth/logout"
    ) {
      next();
      return;
    }
    requireAuth(req, res, next);
  });

  app.get("/api/status", async (_req, res) => {
    res.json(await snapshot());
  });

  app.get("/api/events", (_req, res) => {
    res.json({ events: deps.getEvents() });
  });

  app.get("/api/orders", (_req, res) => {
    res.json({
      orders: deps.broker.getOrdersSync(),
      positions: deps.broker.getPositionsSync(),
    });
  });

  app.get("/api/log", async (_req, res) => {
    if (deps.pool) {
      try {
        res.json({ log: await recentGateLog(deps.pool, 200) });
        return;
      } catch {
        /* fall through */
      }
    }
    res.json({ log: deps.engine.getLogs() });
  });

  app.get("/api/freeze", async (_req, res) => {
    if (deps.pool) {
      try {
        const row = await latestFreeze(deps.pool);
        const parsed = freezeFromRow(row);
        res.json({ freeze: parsed.freeze, knowledgeTime: parsed.knowledgeTime });
        return;
      } catch {
        /* fall through */
      }
    }
    res.json({ freeze: memory.freeze, knowledgeTime: memory.knowledgeTime });
  });

  app.put("/api/freeze", async (req, res) => {
    const body = req.body as Partial<FreezeCard>;
    memory.freeze = {
      consensusObjects: String(body.consensusObjects ?? memory.freeze.consensusObjects),
      sourceLabel: String(body.sourceLabel ?? memory.freeze.sourceLabel),
      fedWatchSnapshot: String(body.fedWatchSnapshot ?? memory.freeze.fedWatchSnapshot),
      liquidContracts: {
        MES: String(body.liquidContracts?.MES ?? memory.freeze.liquidContracts.MES),
        ZN: String(body.liquidContracts?.ZN ?? memory.freeze.liquidContracts.ZN),
        M6E: String(body.liquidContracts?.M6E ?? memory.freeze.liquidContracts.M6E),
        SR3: String(body.liquidContracts?.SR3 ?? memory.freeze.liquidContracts.SR3),
      },
      freezeTimestamp: new Date().toISOString(),
    };
    if (deps.pool) {
      try {
        await insertFreeze(deps.pool, {
          consensus: { text: memory.freeze.consensusObjects },
          source: memory.freeze.sourceLabel,
          fedwatch: memory.freeze.fedWatchSnapshot,
          contracts: memory.freeze.liquidContracts,
          knowledgeTime: memory.knowledgeTime,
          frozenAt: memory.freeze.freezeTimestamp,
        });
      } catch (err) {
        console.error("[EventGate] freeze insert failed", err);
      }
    }
    sessionNote("freeze", "freeze card saved");
    deps.engine.log("freeze card saved");
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/knowledge-time", async (_req, res) => {
    memory.knowledgeTime = new Date().toISOString();
    if (deps.pool) {
      try {
        await stampKnowledgeTime(deps.pool, new Date(memory.knowledgeTime));
      } catch (err) {
        console.error("[EventGate] knowledge_time stamp failed", err);
      }
    }
    sessionNote("knowledge_time", memory.knowledgeTime);
    deps.engine.log(`knowledge_time ${memory.knowledgeTime}`);
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/gate/enable", async (req, res) => {
    const enabled = req.body?.enabled === undefined ? true : Boolean(req.body.enabled);
    deps.engine.enabled = enabled;
    if (deps.redis) {
      await deps.redis.set(REDIS_KEYS.gateEnabled, enabled ? "1" : "0");
    }
    deps.engine.log(enabled ? "gate enabled" : "gate disabled");
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/flatten", async (_req, res) => {
    await deps.engine.flattenSleeve("manual");
    sessionNote("flatten", "manual flatten sleeve");
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/cancel-stops", async (_req, res) => {
    await deps.engine.cancelMarketStops();
    sessionNote("cancel", "manual cancel market/stops");
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/mock/inject-stop", async (req, res) => {
    const { symbol, type, side, qty, price, stopPrice } = req.body ?? {};
    if (!symbol) {
      res.status(400).json({ error: "symbol required" });
      return;
    }
    const order = deps.broker.injectOrder({
      symbol: String(symbol),
      type: type || "StopMarket",
      side: side === "Sell" ? "Sell" : "Buy",
      qty: Number(qty || 1),
      price: price === undefined ? undefined : Number(price),
      stopPrice: stopPrice === undefined ? undefined : Number(stopPrice),
    });
    deps.engine.log(
      `mock inject ${order.type} ${order.symbol} qty ${order.qty}`,
    );
    await publishStatus();
    res.json(await snapshot());
  });

  app.all("/api/checklist", async (req, res) => {
    const body = req.body as Partial<Checklist>;
    memory.checklist = { ...emptyChecklist(), ...memory.checklist, ...body };
    sessionNote("checklist", "checklist updated");
    await publishStatus();
    res.json(await snapshot());
  });

  app.all("/api/daily-loss", async (req, res) => {
    const n = Number(req.body?.dailyLossUsd);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: "dailyLossUsd must be a non-negative number" });
      return;
    }
    deps.engine.dailyLossUsd = n;
    if (deps.redis) await deps.redis.set(REDIS_KEYS.dailyLoss, String(n));
    await publishStatus();
    res.json(await snapshot());
  });

  app.all("/api/day-pnl", async (req, res) => {
    const n = Number(req.body?.dayPnl);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: "dayPnl must be a number" });
      return;
    }
    deps.broker.setDayPnl(n);
    await publishStatus();
    res.json(await snapshot());
  });

  // Reload events from Postgres (or keep seed).
  app.post("/api/events/reload", async (_req, res) => {
    if (deps.pool) {
      try {
        deps.setEvents(await loadEvents(deps.pool));
        deps.engine.log(`reloaded calendar (${deps.getEvents().length} events)`);
      } catch (err) {
        deps.engine.log(`reload failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await publishStatus();
    res.json(await snapshot());
  });

  function parseSleeveId(raw: string): SleeveId | null {
    return (SLEEVE_IDS as readonly string[]).includes(raw) ? (raw as SleeveId) : null;
  }

  app.get("/api/sleeves", async (_req, res) => {
    await ensureSleeves();
    res.json({ sleeves: memory.sleeves, activeSleeve: memory.activeSleeve });
  });

  // Sleeve PUT is thesis/stats only. Paper BUY/SELL is MockBroker via POST /api/paper/order.
  // Live/demo Tradovate is still refused — never EnterLong on a live broker.
  app.put("/api/sleeves/:id", async (req, res) => {
    const id = parseSleeveId(String(req.params.id));
    if (!id) {
      res.status(404).json({ error: "unknown sleeve" });
      return;
    }
    await ensureSleeves();
    memory.sleeves[id] = applySleevePatch(
      memory.sleeves[id],
      (req.body ?? {}) as Record<string, unknown>,
    );
    await persistSleeves();
    sessionNote("sleeve", `${id} saved`);
    deps.engine.log(`sleeve ${id} saved`);
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/sleeves/:id/paper", async (req, res) => {
    const id = parseSleeveId(String(req.params.id));
    if (!id) {
      res.status(404).json({ error: "unknown sleeve" });
      return;
    }
    await ensureSleeves();
    const card = memory.sleeves[id];
    memory.sleeves[id] = {
      ...card,
      paper: applyPaperPatch(card.paper, (req.body ?? {}) as Record<string, unknown>),
      updatedAt: new Date().toISOString(),
    };
    await persistSleeves();
    sessionNote("sleeve", `${id} paper stats`);
    deps.engine.log(`sleeve ${id} paper stats`);
    await publishStatus();
    res.json(await snapshot());
  });

  app.get("/api/quotes", async (req, res) => {
    const id = parseSleeveId(String(req.query.sleeve ?? ""));
    if (!id) {
      res.status(400).json({ error: "sleeve=day|momentum|options|ownership required" });
      return;
    }
    await ensureSleeves();
    const symbols = symbolsForSleeve(memory.sleeves[id], id);
    const quotes = await fetchDelayedQuotes(symbols);
    const hits = await markPaperQuiet();
    if (hits > 0) await publishStatus();
    res.json({ sleeve: id, delayed: true, quotes });
  });

  app.get("/api/scan", async (req, res) => {
    const sleeve = String(req.query.sleeve ?? "");
    if (sleeve !== "momentum" && sleeve !== "ownership") {
      res.status(400).json({ error: "sleeve=momentum|ownership required" });
      return;
    }
    res.json(await getScan(sleeve));
  });

  // Paper journal only. Never send to MockBroker or Tradovate.
  app.post("/api/sleeves/:id/fills", async (req, res) => {
    const id = parseSleeveId(String(req.params.id));
    if (!id) {
      res.status(404).json({ error: "unknown sleeve" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const symbol = String(body.symbol ?? "").trim().toUpperCase();
    const side = body.side === "Sell" ? "Sell" : body.side === "Buy" ? "Buy" : null;
    const qty = typeof body.qty === "number" ? body.qty : Number(body.qty);
    const price = typeof body.price === "number" ? body.price : Number(body.price);
    const notes = typeof body.notes === "string" ? body.notes : "";
    if (!symbol) {
      res.status(400).json({ error: "symbol required" });
      return;
    }
    if (!side) {
      res.status(400).json({ error: "side must be Buy or Sell" });
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      res.status(400).json({ error: "qty must be a positive number" });
      return;
    }
    if (!Number.isFinite(price) || price <= 0) {
      res.status(400).json({ error: "price must be a positive number" });
      return;
    }
    await ensureSleeves();
    await ensureBlotter();
    const fill: PaperFill = {
      id: `fill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      sleeveId: id,
      ts: new Date().toISOString(),
      symbol,
      side,
      qty,
      price,
      notes,
    };
    memory.blotter.push(fill);
    if (memory.blotter.length > 200) {
      memory.blotter.splice(0, memory.blotter.length - 200);
    }
    const card = memory.sleeves[id];
    const paper = { ...card.paper, trades: card.paper.trades + 1 };
    const pnlRaw = body.realizedPnlUsd;
    const pnl = typeof pnlRaw === "number" ? pnlRaw : Number(pnlRaw);
    if (Number.isFinite(pnl)) paper.realizedPnlUsd += pnl;
    memory.sleeves[id] = { ...card, paper, updatedAt: new Date().toISOString() };
    await persistBlotter();
    await persistSleeves();
    sessionNote("paper_fill", `${id} ${side} ${qty} ${symbol} @ ${price} (journal)`);
    deps.engine.log(
      `paper fill ${fill.id} ${side} ${qty} ${symbol} @ ${price} (journal, not broker)`,
    );
    await publishStatus();
    res.json(await snapshot());
  });

  app.delete("/api/sleeves/:id/fills/:fillId", async (req, res) => {
    const id = parseSleeveId(String(req.params.id));
    if (!id) {
      res.status(404).json({ error: "unknown sleeve" });
      return;
    }
    const fillId = String(req.params.fillId ?? "");
    await ensureBlotter();
    const idx = memory.blotter.findIndex((f) => f.id === fillId && f.sleeveId === id);
    if (idx < 0) {
      res.status(404).json({ error: "fill not found" });
      return;
    }
    memory.blotter.splice(idx, 1);
    await persistBlotter();
    sessionNote("paper_fill", `${id} deleted ${fillId}`);
    deps.engine.log(`paper fill ${fillId} deleted (journal)`);
    await publishStatus();
    res.json(await snapshot());
  });

  app.get("/api/options/expiries", async (req, res) => {
    const symbol = String(req.query.symbol ?? "");
    const got = await fetchOptionExpiries(symbol);
    if (!got.ok) {
      res.status(got.status).json({ error: got.error });
      return;
    }
    res.json(got.data);
  });

  app.get("/api/options/chain", async (req, res) => {
    const symbol = String(req.query.symbol ?? "");
    const expiry = typeof req.query.expiry === "string" ? req.query.expiry : undefined;
    const expiryYear = req.query.expiryYear !== undefined ? Number(req.query.expiryYear) : undefined;
    const expiryMonth = req.query.expiryMonth !== undefined ? Number(req.query.expiryMonth) : undefined;
    const expiryDay = req.query.expiryDay !== undefined ? Number(req.query.expiryDay) : undefined;
    const noOfStrikes = req.query.noOfStrikes !== undefined ? Number(req.query.noOfStrikes) : undefined;
    const got = await fetchOptionChain({
      symbol,
      expiry,
      expiryYear: Number.isFinite(expiryYear) ? expiryYear : undefined,
      expiryMonth: Number.isFinite(expiryMonth) ? expiryMonth : undefined,
      expiryDay: Number.isFinite(expiryDay) ? expiryDay : undefined,
      noOfStrikes: Number.isFinite(noOfStrikes) ? noOfStrikes : undefined,
    });
    if (!got.ok) {
      res.status(got.status).json({ error: got.error });
      return;
    }
    res.json(got.data);
  });

  app.post("/api/paper/vertical", async (req, res) => {
    const placed = await placePaperVertical(req.body);
    if (!placed.ok) {
      res.status(placed.status ?? 400).json({ error: placed.error });
      return;
    }
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/paper/csp", async (req, res) => {
    const placed = await placePaperOverlay("csp", req.body);
    if (!placed.ok) {
      res.status(placed.status ?? 400).json({ error: placed.error });
      return;
    }
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/paper/covered-call", async (req, res) => {
    const placed = await placePaperOverlay("covered-call", req.body);
    if (!placed.ok) {
      res.status(placed.status ?? 400).json({ error: placed.error });
      return;
    }
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/paper/order", async (req, res) => {
    if (isVerticalBody(req.body) || String((req.body as { sleeveId?: unknown } | undefined)?.sleeveId ?? "") === "options") {
      if (isVerticalBody(req.body)) {
        const placedV = await placePaperVertical({ ...(req.body as object), sleeveId: "options" });
        if (!placedV.ok) {
          res.status(placedV.status ?? 400).json({ error: placedV.error });
          return;
        }
        await publishStatus();
        res.json(await snapshot());
        return;
      }
    }
    const parsed = parsePaperOrder(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const placed = await placePaperOrder(parsed);
    if (!placed.ok) {
      res.status(placed.error.includes("MockBroker only") ? 403 : 400).json({ error: placed.error });
      return;
    }
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/paper/close", async (req, res) => {
    const parsed = parsePaperClose(req.body);
    if ("error" in parsed) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    const closed = await closePaperPosition(parsed);
    if (!closed.ok) {
      const status = closed.status ?? (closed.error.includes("MockBroker only") ? 403 : 400);
      res.status(status).json({ error: closed.error });
      return;
    }
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/paper/auto", async (req, res) => {
    await ensureAutoPaper();
    const enabled = Boolean(req.body?.enabled);
    memory.autoPaper = enabled;
    await persistAutoPaper();
    deps.engine.log(
      enabled
        ? "auto paper enabled (mock only, day sleeve not auto)"
        : "auto paper disabled",
    );
    if (enabled) await runWiredAutopilot();
    await publishStatus();
    res.json(await snapshot());
  });

  attachScanReady(() => {
    void runWiredAutopilot();
  });
  stopAutoPaperLoop();
  if (deps.cfg.nodeEnv !== "test") {
    autoPaperTimer = setInterval(() => {
      void runWiredAutopilot();
    }, AUTO_PAPER_INTERVAL_MS);
  }

  return app;
}

export { DEFAULT_DAILY_LOSS_USD };
