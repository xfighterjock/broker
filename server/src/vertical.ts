import {
  DEFAULT_SLEEVE_EQUITY_USD,
  OPTIONS_DEBIT_CAP_FRAC,
  OPTIONS_DEBIT_MAX_WIDTH_FRAC,
  OPTIONS_DEBIT_STOP_FRAC,
  OPTIONS_DEBIT_TARGET_FRAC,
  OPTIONS_DTE_EXIT,
  OPTIONS_MULTIPLIER,
  OPTIONS_PROFIT_TAKE_FRAC,
  OPTIONS_VERTICAL_CUTOFF_MINUTES,
  SLEEVE_IDS,
  TZ,
} from "../../shared/constants";
import type {
  OptionLeg,
  OptionRight,
  Position,
  VerticalMeta,
} from "../../shared/types";

export type VerticalSleeveId = "options" | "riskoff";

export type VerticalBody = {
  sleeveId: VerticalSleeveId;
  symbol: string;
  right: OptionRight;
  expiry: string;
  longStrike: number;
  shortStrike: number;
  longOsiKey?: string;
  shortOsiKey?: string;
  qty?: number;
  thesis: string;
  asOf?: string;
};

export type VerticalOk = {
  ok: true;
  quoteSymbol: string;
  right: OptionRight;
  expiry: string;
  long: OptionLeg;
  short: OptionLeg;
  qty: number;
  netDebitPerShare: number;
  netDebitPaid: number;
  maxLoss: number;
  maxProfit: number;
  width: number;
  longFill: number;
  shortFill: number;
  asOf: string;
  warn?: string;
};

export type VerticalErr = { ok: false; error: string };

let paperNowOverride: Date | null = null;

/** Injected valuation clock for tests and sandbox 2013 expiries. */
export function setPaperNow(d: Date | null): void {
  paperNowOverride = d;
}

export function getPaperNow(): Date | null {
  return paperNowOverride;
}

export function valuationNow(asOf?: string, injected?: Date): Date {
  if (injected) return injected;
  if (paperNowOverride) return paperNowOverride;
  if (asOf) {
    const d = new Date(asOf);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

const WEEKDAY_SUN0: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/** America/New_York wall clock: YYYY-MM-DD, minutes since midnight, weekday Sun=0 Sat=6. */
export function etWall(now: Date): { ymd: string; minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const y = get("year");
  const mo = get("month");
  const d = get("day");
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const weekdayName = get("weekday");
  return {
    ymd: `${y}-${mo}-${d}`,
    minutes: hour * 60 + minute,
    weekday: WEEKDAY_SUN0[weekdayName] ?? 0,
  };
}

/** Mon–Fri ET and before OPTIONS_VERTICAL_CUTOFF_MINUTES. Uses valuationNow when now is omitted. */
export function verticalEntryWindowOpen(now?: Date): boolean {
  const clock = valuationNow(undefined, now);
  const w = etWall(clock);
  return w.weekday >= 1 && w.weekday <= 5 && w.minutes < OPTIONS_VERTICAL_CUTOFF_MINUTES;
}

export function verticalEntryWindowError(now?: Date): string | null {
  return verticalEntryWindowOpen(now) ? null : "no new verticals after 15:50 ET";
}

export function isVerticalStopReason(reason: string): boolean {
  return /stop/i.test(reason);
}

export function noteVerticalStop(
  map: Record<string, string>,
  symbol: string,
  at: Date,
): Record<string, string> {
  const sym = symbol.trim().toUpperCase();
  return { ...map, [sym]: etWall(at).ymd };
}

export function verticalStopCooling(
  map: Record<string, string>,
  symbol: string,
  at: Date,
): boolean {
  const sym = symbol.trim().toUpperCase();
  return map[sym] === etWall(at).ymd;
}

export function parseYmdParts(expiry: string): { y: number; m: number; d: number } | null {
  const m = expiry.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
}

export function daysToExpiry(expiry: string, now: Date): number {
  const p = parseYmdParts(expiry);
  if (!p) return Number.NaN;
  const exp = Date.UTC(p.y, p.m - 1, p.d);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((exp - today) / 86_400_000);
}

export function addDaysYmd(expiry: string, days: number): string {
  const p = parseYmdParts(expiry);
  if (!p) return expiry;
  const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function defaultAsOfForExpiry(expiry: string, now: Date): string {
  const dte = daysToExpiry(expiry, now);
  if (Number.isFinite(dte) && dte > OPTIONS_DTE_EXIT) return now.toISOString();
  // Canned sandbox expiries (2013) are in the past vs wall clock — pin 45 DTE so we do not false-close.
  return addDaysYmd(expiry, -45) + "T15:00:00.000Z";
}

export function isVerticalBody(body: unknown): boolean {
  const b = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (!b) return false;
  if (b.longStrike !== undefined && b.shortStrike !== undefined) return true;
  if (b.longOsiKey && b.shortOsiKey) return true;
  return false;
}

export function parsePaperVertical(body: unknown): VerticalBody | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const sleeveRaw = String(b.sleeveId ?? "options");
  if (!(SLEEVE_IDS as readonly string[]).includes(sleeveRaw)) {
    return { error: `sleeveId must be ${(SLEEVE_IDS as readonly string[]).join("|")}` };
  }
  if (sleeveRaw !== "options" && sleeveRaw !== "riskoff") {
    return { error: "debit verticals are options or riskoff sleeve only" };
  }
  const symbol = String(b.symbol ?? "").trim().toUpperCase();
  if (!symbol) return { error: "symbol required" };
  const rightRaw = String(b.right ?? "").trim().toUpperCase();
  const right: OptionRight | null =
    rightRaw === "C" || rightRaw === "CALL" ? "C" : rightRaw === "P" || rightRaw === "PUT" ? "P" : null;
  if (!right) return { error: "right must be C or P" };
  if (sleeveRaw === "riskoff" && right !== "P") {
    return { error: "riskoff sleeve: put debit verticals only (no calls)" };
  }
  let expiry = String(b.expiry ?? "").trim();
  if (!expiry) {
    const y = Number(b.expiryYear);
    const m = Number(b.expiryMonth);
    const d = Number(b.expiryDay);
    if (Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)) {
      expiry = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  if (!parseYmdParts(expiry)) return { error: "expiry must be YYYY-MM-DD" };
  const longStrike = typeof b.longStrike === "number" ? b.longStrike : Number(b.longStrike);
  const shortStrike = typeof b.shortStrike === "number" ? b.shortStrike : Number(b.shortStrike);
  if (!Number.isFinite(longStrike) || !Number.isFinite(shortStrike)) {
    return { error: "longStrike and shortStrike required" };
  }
  let qty: number | undefined;
  if (b.qty !== undefined && b.qty !== null && b.qty !== "") {
    const q = typeof b.qty === "number" ? b.qty : Number(b.qty);
    if (!Number.isFinite(q) || q < 1 || !Number.isInteger(q)) return { error: "qty must be an integer >= 1" };
    qty = q;
  }
  const thesis = typeof b.thesis === "string" ? b.thesis : String(b.thesis ?? "");
  const asOf = typeof b.asOf === "string" && b.asOf.trim() ? b.asOf.trim() : undefined;
  const longOsiKey = typeof b.longOsiKey === "string" && b.longOsiKey.trim() ? b.longOsiKey.trim() : undefined;
  const shortOsiKey = typeof b.shortOsiKey === "string" && b.shortOsiKey.trim() ? b.shortOsiKey.trim() : undefined;
  return {
    sleeveId: sleeveRaw as VerticalSleeveId,
    symbol,
    right,
    expiry,
    longStrike,
    shortStrike,
    longOsiKey,
    shortOsiKey,
    qty,
    thesis,
    asOf,
  };
}

function furtherOtm(right: OptionRight, longStrike: number, shortStrike: number): boolean {
  if (right === "C") return shortStrike > longStrike;
  return shortStrike < longStrike;
}

export function sizeDebitContracts(
  netDebitPerShare: number,
  equityUsd: number,
  requestedQty?: number,
): { ok: true; qty: number } | { ok: false; error: string } {
  if (!(netDebitPerShare > 0)) return { ok: false, error: "net debit must be > 0" };
  const per = netDebitPerShare * OPTIONS_MULTIPLIER;
  const equity = Number.isFinite(equityUsd) && equityUsd > 0 ? equityUsd : DEFAULT_SLEEVE_EQUITY_USD;
  const cap = equity * OPTIONS_DEBIT_CAP_FRAC;
  const target = equity * OPTIONS_DEBIT_TARGET_FRAC;
  if (per > cap) {
    return { ok: false, error: `1 contract debit $${per.toFixed(0)} exceeds 2% equity cap $${cap.toFixed(0)}` };
  }
  if (requestedQty !== undefined) {
    const paid = per * requestedQty;
    if (paid > cap) {
      return { ok: false, error: `net debit $${paid.toFixed(0)} exceeds 2% equity cap $${cap.toFixed(0)}` };
    }
    return { ok: true, qty: requestedQty };
  }
  let qty = Math.floor(target / per);
  if (qty < 1) qty = 1;
  while (qty > 1 && qty * per > cap) qty -= 1;
  if (qty * per > cap) {
    return { ok: false, error: `net debit exceeds 2% equity cap $${cap.toFixed(0)}` };
  }
  return { ok: true, qty };
}

export function validateDebitVertical(
  input: {
    long: OptionLeg;
    short: OptionLeg;
    qty?: number;
    asOf?: string;
    quoteSymbol?: string;
  },
  equityUsd: number,
  now?: Date,
): VerticalOk | VerticalErr {
  const { long, short } = input;
  if (long.right !== short.right) {
    return { ok: false, error: "mixed-right verticals refused (call debit or put debit only)" };
  }
  if (long.expiry !== short.expiry) {
    return { ok: false, error: "mixed-expiry verticals refused" };
  }
  if (long.underlying.toUpperCase() !== short.underlying.toUpperCase()) {
    return { ok: false, error: "legs must share an underlying" };
  }
  if (Math.abs(long.strike - short.strike) < 1e-9) {
    return { ok: false, error: "vertical requires two different strikes" };
  }
  if (!furtherOtm(long.right, long.strike, short.strike)) {
    return {
      ok: false,
      error:
        long.right === "C"
          ? "call debit requires long lower strike / short further OTM (no credit spreads)"
          : "put debit requires long higher strike / short further OTM (no credit spreads)",
    };
  }
  const longAsk = long.ask;
  const shortBid = short.bid;
  if (longAsk === null || shortBid === null || !Number.isFinite(longAsk) || !Number.isFinite(shortBid)) {
    return { ok: false, error: "missing bid/ask; refuse" };
  }
  const netDebitPerShare = longAsk - shortBid;
  if (!(netDebitPerShare > 0)) {
    return { ok: false, error: "net debit must be > 0 (credit / even spreads refused)" };
  }
  const width = Math.abs(short.strike - long.strike);
  if (netDebitPerShare >= width) {
    return { ok: false, error: "net debit >= width (no defined profit)" };
  }
  if (netDebitPerShare > width * OPTIONS_DEBIT_MAX_WIDTH_FRAC + 1e-9) {
    return { ok: false, error: "net debit exceeds half the width" };
  }
  const sized = sizeDebitContracts(netDebitPerShare, equityUsd, input.qty);
  if (!sized.ok) return sized;
  const qty = sized.qty;
  const netDebitPaid = netDebitPerShare * OPTIONS_MULTIPLIER * qty;
  const maxLoss = netDebitPaid;
  const maxProfit = (width - netDebitPerShare) * OPTIONS_MULTIPLIER * qty;
  const clock = valuationNow(input.asOf, now);
  const asOf = input.asOf ?? defaultAsOfForExpiry(long.expiry, clock);
  return {
    ok: true,
    quoteSymbol: (input.quoteSymbol || long.underlying).toUpperCase(),
    right: long.right,
    expiry: long.expiry,
    long,
    short,
    qty,
    netDebitPerShare,
    netDebitPaid,
    maxLoss,
    maxProfit,
    width,
    longFill: longAsk,
    shortFill: shortBid,
    asOf,
  };
}

export function verticalPackageSymbol(v: {
  underlying: string;
  expiry: string;
  right: OptionRight;
  longStrike: number;
  shortStrike: number;
}): string {
  return `${v.underlying} ${fmtStrike(v.longStrike)}/${fmtStrike(v.shortStrike)} ${v.right} ${v.expiry}`;
}

function fmtStrike(n: number): string {
  return Number.isInteger(n) ? String(n) : String(n);
}

export function makeVerticalMeta(v: VerticalOk, openedAt = new Date().toISOString()): VerticalMeta {
  return {
    kind: "debit-vertical",
    right: v.right,
    expiry: v.expiry,
    underlying: v.long.underlying,
    quoteSymbol: v.quoteSymbol,
    qty: v.qty,
    long: v.long,
    short: v.short,
    longFill: v.longFill,
    shortFill: v.shortFill,
    netDebitPerShare: v.netDebitPerShare,
    netDebitPaid: v.netDebitPaid,
    maxLoss: v.maxLoss,
    maxProfit: v.maxProfit,
    width: v.width,
    openedAt,
    asOf: v.asOf,
  };
}

/** Close both legs: sell long at bid, buy short at ask. */
export function verticalCloseValue(long: OptionLeg, short: OptionLeg, qty: number): number | null {
  if (long.bid === null || short.ask === null) return null;
  if (!Number.isFinite(long.bid) || !Number.isFinite(short.ask)) return null;
  return (long.bid - short.ask) * OPTIONS_MULTIPLIER * qty;
}

export function verticalUnrealized(meta: VerticalMeta, long: OptionLeg, short: OptionLeg): number | null {
  const close = verticalCloseValue(long, short, meta.qty);
  if (close === null) return null;
  return close - meta.netDebitPaid;
}

export type VerticalExit = {
  position: Position;
  reason: string;
  closeValue: number;
  realizedPnl: number;
  longBid: number;
  shortAsk: number;
};

export function detectVerticalExits(
  positions: Position[],
  now?: Date,
): VerticalExit[] {
  const hits: VerticalExit[] = [];
  for (const p of positions) {
    const v = p.vertical;
    if (!v || p.side === "Flat" || p.qty <= 0) continue;
    const close = verticalCloseValue(v.long, v.short, v.qty);
    if (close === null) continue;
    const pnl = close - v.netDebitPaid;
    const markNow = valuationNow(v.asOf, now);
    const dte = daysToExpiry(v.expiry, markNow);
    let reason: string | null = null;
    if (Number.isFinite(dte) && dte <= OPTIONS_DTE_EXIT) {
      reason = `DTE ${dte} <= ${OPTIONS_DTE_EXIT}`;
    } else if (close <= v.netDebitPaid * OPTIONS_DEBIT_STOP_FRAC) {
      reason = "50% debit stop";
    } else if (pnl >= v.maxProfit * OPTIONS_PROFIT_TAKE_FRAC) {
      reason = "50% max profit";
    }
    if (!reason) continue;
    hits.push({
      position: p,
      reason,
      closeValue: close,
      realizedPnl: pnl,
      longBid: v.long.bid as number,
      shortAsk: v.short.ask as number,
    });
  }
  return hits;
}

export function applyVerticalMarks(meta: VerticalMeta, long: OptionLeg, short: OptionLeg): VerticalMeta {
  return {
    ...meta,
    long: { ...meta.long, ...long, right: meta.long.right, strike: meta.long.strike, expiry: meta.long.expiry },
    short: { ...meta.short, ...short, right: meta.short.right, strike: meta.short.strike, expiry: meta.short.expiry },
  };
}

export function isVerticalPosition(p: Position): boolean {
  return Boolean(p.vertical && p.vertical.kind === "debit-vertical");
}
