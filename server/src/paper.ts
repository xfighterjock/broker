import { extractRoot, isGatedSymbol } from "../../shared/clock";
import type {
  DelayedQuote,
  GateMode,
  PaperFill,
  PaperStats,
  Position,
  PositionSide,
  Side,
  SleeveBook,
  SleeveCard,
  SleeveId,
  WorkingOrder,
} from "../../shared/types";
import {
  DEFAULT_SLEEVE_EQUITY_USD,
  RISKOFF_ETF_SYMBOLS,
  SLEEVE_IDS,
  TZ,
} from "../../shared/constants";
import { mapTicker } from "./quotes";
import { isOverlayPosition } from "./overlay";
import { isVerticalPosition } from "./vertical";

/** USD per full index/price point. ETFs and unknowns use 1.0 (points if unlabeled). */
export const POINT_VALUE: Record<string, number> = {
  MES: 5,
  ES: 50,
  NQ: 20,
  MNQ: 2,
  M6E: 12_500,
  "6E": 125_000,
  SR3: 25,
  ZN: 1000,
};

export const OPTIONS_ETFS = new Set(["SPY", "QQQ", "IWM"]);

export type PaperOrderBody = {
  sleeveId: SleeveId;
  symbol: string;
  side: Side;
  qty: number;
  stopPrice: number;
  thesis: string;
};

export type PaperCloseBody = {
  sleeveId: SleeveId;
  symbol: string;
  reason: string;
};

export type ValidateOk = {
  ok: true;
  mapped: string;
  root: string | null;
  pointValue: number;
  pnlUnit: "usd" | "points";
  warn?: string;
};

export type ValidateErr = { ok: false; error: string };

export function pointValueFor(symbol: string): { value: number; unit: "usd" | "points" } {
  const root = extractRoot(symbol);
  if (root && root in POINT_VALUE) return { value: POINT_VALUE[root], unit: "usd" };
  const compact = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (compact in POINT_VALUE) return { value: POINT_VALUE[compact], unit: "usd" };
  if (root) return { value: 1, unit: "points" };
  return { value: 1, unit: "usd" };
}

export function stopOnCorrectSide(side: Side, last: number, stopPrice: number): boolean {
  if (side === "Buy") return stopPrice < last;
  return stopPrice > last;
}

export function lastCrossesStop(posSide: PositionSide, stopPrice: number, last: number): boolean {
  if (posSide === "Long") return last <= stopPrice;
  if (posSide === "Short") return last >= stopPrice;
  return false;
}

export function signedPnl(
  posSide: PositionSide,
  avgPrice: number,
  exit: number,
  qty: number,
  symbol: string,
): number {
  const { value } = pointValueFor(symbol);
  const dir = posSide === "Short" ? -1 : 1;
  return (exit - avgPrice) * dir * qty * value;
}

export function lastFromQuotes(quotes: DelayedQuote[], symbol: string): number | null {
  const mapped = (mapTicker(symbol) ?? symbol).toUpperCase();
  const raw = symbol.trim().toUpperCase();
  for (const q of quotes) {
    const qs = q.symbol.toUpperCase();
    if (q.last === null || !Number.isFinite(q.last)) continue;
    if (qs === mapped || qs === raw || qs === `${raw}=F` || mapped === `${qs}`) return q.last;
  }
  return null;
}


export function validatePaperOrder(
  input: PaperOrderBody,
  ctx: {
    last: number;
    gateMode: GateMode;
    dailyLossUsd: number;
    dayPnl: number;
    sleeveRealizedPnl: number;
  },
): ValidateOk | ValidateErr {
  const mapped = mapTicker(input.symbol);
  if (!mapped) return { ok: false, error: "symbol required" };
  if (!stopOnCorrectSide(input.side, ctx.last, input.stopPrice)) {
    return {
      ok: false,
      error:
        input.side === "Buy"
          ? "Buy stop must be below last"
          : "Sell stop must be above last",
    };
  }
  const pv = pointValueFor(mapped);
  const dist = Math.abs(input.stopPrice - ctx.last);
  const pct = ctx.last !== 0 ? dist / Math.abs(ctx.last) : 0;
  let warn: string | undefined;
  if (pct > 0.02 || pct < 0.01) {
    warn = `stop ${ (pct * 100).toFixed(2) }% from last (1–2% is typical; not blocked)`;
  }

  if (input.sleeveId === "day") {
    if (input.qty !== 1) return { ok: false, error: "day sleeve qty must be 1" };
    if (ctx.gateMode === "NO-STOP BAND") {
      return { ok: false, error: "NO-STOP BAND refuses market entry" };
    }
    if (!isGatedSymbol(mapped)) {
      return { ok: false, error: "day sleeve: gated futures only (MES/ZN/M6E/SR3/ES/NQ/6E/…)" };
    }
    const potential = dist * input.qty * pv.value;
    const cap = Math.abs(ctx.dailyLossUsd);
    if (cap > 0) {
      if (ctx.dayPnl <= -cap) {
        return { ok: false, error: "day P&L already at dailyLossUsd" };
      }
      if (ctx.dayPnl - potential <= -cap) {
        return { ok: false, error: "stop loss would exceed dailyLossUsd" };
      }
      if (ctx.sleeveRealizedPnl <= -cap) {
        return { ok: false, error: "sleeve day loss already at dailyLossUsd" };
      }
      if (ctx.sleeveRealizedPnl - potential <= -cap) {
        return { ok: false, error: "stop loss would exceed dailyLossUsd" };
      }
    }
  } else {
    if (input.qty < 1) return { ok: false, error: "qty must be >= 1" };
  }

  if (input.sleeveId === "options") {
    return {
      ok: false,
      error: "options sleeve: paper debit verticals only (POST /api/paper/vertical); no stock legs",
    };
  }
  if (input.sleeveId === "riskoff") {
    const etf = input.symbol.trim().toUpperCase();
    if (!(RISKOFF_ETF_SYMBOLS as readonly string[]).includes(etf)) {
      return {
        ok: false,
        error:
          "riskoff sleeve: put debit verticals (POST /api/paper/vertical) or GLD/UUP/BIL ETF long only",
      };
    }
    if (input.side !== "Buy") {
      return {
        ok: false,
        error: "riskoff ETF: long only (close via POST /api/paper/close)",
      };
    }
  }

  return {
    ok: true,
    mapped,
    root: extractRoot(mapped),
    pointValue: pv.value,
    pnlUnit: pv.unit,
    warn,
  };
}

export function parsePaperOrder(body: unknown): PaperOrderBody | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sleeveRaw = String(b.sleeveId ?? "");
  if (!(SLEEVE_IDS as readonly string[]).includes(sleeveRaw)) {
    return { error: `sleeveId must be ${(SLEEVE_IDS as readonly string[]).join("|")}` };
  }
  const symbol = String(b.symbol ?? "").trim().toUpperCase();
  if (!symbol) return { error: "symbol required" };
  const side: Side | null = b.side === "Buy" || b.side === "Sell" ? b.side : null;
  if (!side) return { error: "side must be Buy or Sell" };
  const qty = typeof b.qty === "number" ? b.qty : Number(b.qty);
  if (!Number.isFinite(qty) || qty < 1) return { error: "qty must be >= 1" };
  const stopPrice = typeof b.stopPrice === "number" ? b.stopPrice : Number(b.stopPrice);
  if (!Number.isFinite(stopPrice)) return { error: "stopPrice required" };
  const thesis = typeof b.thesis === "string" ? b.thesis : String(b.thesis ?? "");
  return {
    sleeveId: sleeveRaw as SleeveId,
    symbol,
    side,
    qty,
    stopPrice,
    thesis,
  };
}

export function parsePaperClose(body: unknown): PaperCloseBody | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sleeveRaw = String(b.sleeveId ?? "");
  if (!(SLEEVE_IDS as readonly string[]).includes(sleeveRaw)) {
    return { error: `sleeveId must be ${(SLEEVE_IDS as readonly string[]).join("|")}` };
  }
  const symbol = String(b.symbol ?? "").trim().toUpperCase();
  if (!symbol) return { error: "symbol required" };
  const reason = typeof b.reason === "string" && b.reason.trim() ? b.reason.trim() : "manual";
  return { sleeveId: sleeveRaw as SleeveId, symbol, reason };
}

export function oppositeSide(side: Side): Side {
  return side === "Buy" ? "Sell" : "Buy";
}

export function positionSideFor(side: Side): "Long" | "Short" {
  return side === "Buy" ? "Long" : "Short";
}

export function closeSideFor(posSide: PositionSide): Side {
  return posSide === "Short" ? "Buy" : "Sell";
}

export type StopHit = {
  position: Position;
  stop: WorkingOrder;
  last: number;
  realizedPnl: number;
};

export function detectStopHits(
  positions: Position[],
  orders: WorkingOrder[],
  quotes: DelayedQuote[],
): StopHit[] {
  const live = new Set(["Working", "Submitted", "Accepted"]);
  const hits: StopHit[] = [];
  for (const p of positions) {
    if (p.side === "Flat" || p.qty <= 0) continue;
    if (isVerticalPosition(p) || isOverlayPosition(p)) continue;
    const last = lastFromQuotes(quotes, p.symbol);
    if (last === null) continue;
    const stop = orders.find(
      (o) =>
        live.has(o.state) &&
        (o.type === "StopMarket" || o.type === "StopLimit") &&
        (o.symbol.toUpperCase() === p.symbol.toUpperCase() ||
          (o.root !== null && p.root !== null && o.root === p.root)) &&
        (o.sleeveId === undefined || p.sleeveId === undefined || o.sleeveId === p.sleeveId),
    );
    if (!stop || stop.stopPrice === undefined || !Number.isFinite(stop.stopPrice)) continue;
    if (!lastCrossesStop(p.side, stop.stopPrice, last)) continue;
    hits.push({
      position: p,
      stop,
      last,
      realizedPnl: signedPnl(p.side, p.avgPrice, last, p.qty, p.symbol),
    });
  }
  return hits;
}

export function applyExitStats(paper: PaperStats, realizedPnl: number): PaperStats {
  return {
    ...paper,
    trades: paper.trades + 1,
    wins: paper.wins + (realizedPnl >= 0 ? 1 : 0),
    losses: paper.losses + (realizedPnl < 0 ? 1 : 0),
    realizedPnlUsd: paper.realizedPnlUsd + realizedPnl,
  };
}

export function newFillId(): string {
  return `fill-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function makeFill(partial: Omit<PaperFill, "id" | "ts"> & { ts?: string; id?: string }): PaperFill {
  return {
    id: partial.id ?? newFillId(),
    ts: partial.ts ?? new Date().toISOString(),
    sleeveId: partial.sleeveId,
    symbol: partial.symbol,
    side: partial.side,
    qty: partial.qty,
    price: partial.price,
    notes: partial.notes,
  };
}


export function positionBelongsToSleeve(sleeveId: SleeveId, tagged?: SleeveId): boolean {
  if (tagged === sleeveId) return true;
  if (!tagged && sleeveId === "day") return true;
  return false;
}

export function sleeveBook(
  sleeve: SleeveCard,
  positions: Position[],
  quotes: DelayedQuote[] = [],
  startingEquity = DEFAULT_SLEEVE_EQUITY_USD,
): SleeveBook {
  const realizedPnlUsd = sleeve.paper.realizedPnlUsd;
  let unrealizedPnlUsd = 0;
  for (const p of positions) {
    if (p.side === "Flat" || p.qty <= 0) continue;
    if (!positionBelongsToSleeve(sleeve.id, p.sleeveId)) continue;
    if (isVerticalPosition(p) || isOverlayPosition(p)) {
      unrealizedPnlUsd += p.unrealizedPnl;
      continue;
    }
    const last = quotes.length ? lastFromQuotes(quotes, p.symbol) : null;
    if (last !== null) {
      unrealizedPnlUsd += signedPnl(p.side, p.avgPrice, last, p.qty, p.symbol);
    } else {
      unrealizedPnlUsd += p.unrealizedPnl;
    }
  }
  const pnlUsd = realizedPnlUsd + unrealizedPnlUsd;
  const equityUsd = startingEquity + pnlUsd;
  const { totalPnlUsd, dailyPnlUsd } = computeSleevePnl({
    equityUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    startingEquity,
    sessionMark: null,
    todayRealizedPnlUsd: 0,
  });
  return {
    equityUsd,
    realizedPnlUsd,
    unrealizedPnlUsd,
    pnlUsd,
    totalPnlUsd,
    dailyPnlUsd,
  };
}

export type SessionMark = {
  sessionDate: string;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
};

/** America/New_York calendar date YYYY-MM-DD. */
export function nySessionDate(now = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: TZ });
}

/**
 * totalPnl = equity - starting (100k).
 * With a session mark: daily = Δrealized + Δunrealized vs that mark.
 * With no mark: daily = today's realized (default 0) + uPnL change from 0 at session start.
 */
export function computeSleevePnl(input: {
  equityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  startingEquity?: number;
  sessionMark: SessionMark | null;
  todayRealizedPnlUsd?: number;
}): { totalPnlUsd: number; dailyPnlUsd: number } {
  const starting = input.startingEquity ?? DEFAULT_SLEEVE_EQUITY_USD;
  const totalPnlUsd = input.equityUsd - starting;
  if (input.sessionMark) {
    return {
      totalPnlUsd,
      dailyPnlUsd:
        input.realizedPnlUsd -
        input.sessionMark.realizedPnlUsd +
        (input.unrealizedPnlUsd - input.sessionMark.unrealizedPnlUsd),
    };
  }
  const todayRealized = input.todayRealizedPnlUsd ?? 0;
  return { totalPnlUsd, dailyPnlUsd: todayRealized + input.unrealizedPnlUsd };
}

/**
 * No prior snapshot: mark realized at current (so only new fills count) and uPnL from 0.
 * New NY session with a prior mark: snapshot the start-of-day book.
 */
export function openSessionMark(
  sessionDate: string,
  realizedPnlUsd: number,
  unrealizedPnlUsd: number,
  prior: SessionMark | null,
): SessionMark {
  if (prior && prior.sessionDate === sessionDate) return prior;
  if (!prior) {
    return { sessionDate, realizedPnlUsd, unrealizedPnlUsd: 0 };
  }
  return { sessionDate, realizedPnlUsd, unrealizedPnlUsd };
}

export function applySessionPnl(
  book: SleeveBook,
  mark: SessionMark | null,
  startingEquity = DEFAULT_SLEEVE_EQUITY_USD,
): SleeveBook {
  const { totalPnlUsd, dailyPnlUsd } = computeSleevePnl({
    equityUsd: book.equityUsd,
    realizedPnlUsd: book.realizedPnlUsd,
    unrealizedPnlUsd: book.unrealizedPnlUsd,
    startingEquity,
    sessionMark: mark,
    todayRealizedPnlUsd: mark ? undefined : 0,
  });
  return { ...book, totalPnlUsd, dailyPnlUsd, pnlUsd: totalPnlUsd };
}

export function allSleeveBooks(
  sleeves: Record<SleeveId, SleeveCard>,
  positions: Position[],
  quotes: DelayedQuote[] = [],
  sessionMarks?: Record<SleeveId, SessionMark | null>,
  now?: Date,
): Record<SleeveId, SleeveBook> {
  const out = {} as Record<SleeveId, SleeveBook>;
  const sessionDate = nySessionDate(now);
  for (const id of SLEEVE_IDS) {
    const raw = sleeveBook(sleeves[id], positions, quotes);
    const prior = sessionMarks ? sessionMarks[id] ?? null : null;
    const mark = sessionMarks
      ? openSessionMark(sessionDate, raw.realizedPnlUsd, raw.unrealizedPnlUsd, prior)
      : null;
    out[id] = applySessionPnl(raw, mark);
  }
  return out;
}

export function rollSessionMarks(
  books: Record<SleeveId, SleeveBook>,
  prior: Record<SleeveId, SessionMark | null> | null | undefined,
  now?: Date,
): Record<SleeveId, SessionMark> {
  const sessionDate = nySessionDate(now);
  const out = {} as Record<SleeveId, SessionMark>;
  for (const id of SLEEVE_IDS) {
    const book = books[id];
    out[id] = openSessionMark(
      sessionDate,
      book.realizedPnlUsd,
      book.unrealizedPnlUsd,
      prior?.[id] ?? null,
    );
  }
  return out;
}
