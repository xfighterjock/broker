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
  closeSideFor,
  detectStopHits,
  lastFromQuotes,
  makeFill,
  oppositeSide,
  parsePaperClose,
  parsePaperOrder,
  positionSideFor,
  signedPnl,
  sleeveBook,
  validatePaperOrder,
  type PaperCloseBody,
  type PaperOrderBody,
} from "./paper";
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
      const last = lastFromQuotes(quotes, p.symbol);
      if (last === null) continue;
      deps.broker.setUnrealizedPnl(p.symbol, signedPnl(p.side, p.avgPrice, last, p.qty, p.symbol));
    }
    return hits.length;
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
    if (parsed.sleeveId === "options") {
      deps.engine.log(
        "options sleeve: option legs are not modeled yet; paper is underlying ETF only (SPY/QQQ/IWM)",
      );
    }
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
    const quotes = await fetchDelayedQuotes([pos.symbol]);
    const last = lastFromQuotes(quotes, pos.symbol);
    if (last === null) return { ok: false, error: "no delayed last" };
    const pnl = signedPnl(pos.side, pos.avgPrice, last, pos.qty, pos.symbol);
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
      price: last,
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
      sleeveBooks: allSleeveBooks(memory.sleeves, deps.broker.getPositionsSync()),
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

  app.post("/api/paper/order", async (req, res) => {
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
