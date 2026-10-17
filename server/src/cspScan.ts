/**
 * Pure cash-secured-put scan schedule, beta, signals, and chain shaping.
 * Network lives in cspLive.ts. No orders.
 */

import { etParts } from "../../shared/clock";
import { cashSessionCloseMinute, nextCashOpenDate } from "../../shared/marketSession";
import type { OptionLeg } from "../../shared/types";
import {
  CSP_BS_RATE_FALLBACK,
  betaToBenchmark,
  calendarDte,
  cspEntrySignal,
  dailyReturns,
  earningsWindowDecision,
  isHighBeta,
  optionMid,
  pickCspExpiry,
  pickCspStrike,
  recorderKeepsPut,
  resolvePutDelta,
  swingLowBeforeEntry,
  type PutQuote,
} from "./cspMath";
import type { CspCandidate } from "./cspCycle";

export const CSP_SCAN_START_MINUTE = 16 * 60 + 10;
export const CSP_SCAN_END_MINUTE = 16 * 60 + 25;
export const CSP_SCAN_STALE_MS = 26 * 60 * 60 * 1000;
export const CSP_RECORDER_TOP_BETA = 50;

export interface CspDailyBar {
  ymd: string;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface CspPendingSignal {
  symbol: string;
  signalYmd: string;
  tradeYmd: string;
  swingLow: number | null;
  /** null = calendar unknown (entry will skip). */
  earnings: string[] | null;
  beta: number;
  /** Last trading day of the prior calendar month. Eligibility uses this beta only. */
  betaAsOfYmd?: string;
}

export interface CspBetaRank {
  symbol: string;
  beta: number;
  /** Month-end session this beta was measured through. Absent on a pre-rule cache. */
  asOfYmd?: string;
}

export const CSP_QUEUE_DROP_OPEN = "already open";
export const CSP_QUEUE_DROP_BETA = "beta below 1.3 at month end";

export function etYmd(now: Date): string {
  const p = etParts(now);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function etMinuteOfDay(now: Date): number {
  const p = etParts(now);
  return p.hour * 60 + p.minute;
}

/** 16:10–16:25 ET on a cash-session day, including early-close days. */
export function cspCloseScanWindow(now: Date): boolean {
  const p = etParts(now);
  if (cashSessionCloseMinute(p.year, p.month, p.day) === null) return false;
  const minute = etMinuteOfDay(now);
  return minute >= CSP_SCAN_START_MINUTE && minute < CSP_SCAN_END_MINUTE;
}

/**
 * Close window once per ET date, or any time the last scan is missing / older
 * than 26 hours (process start after a missed close).
 */
export function cspScanDue(scannedAtIso: string | null, scannedYmd: string | null, now: Date): boolean {
  if (cspCloseScanWindow(now) && scannedYmd !== etYmd(now)) return true;
  if (!scannedAtIso) return true;
  const age = now.getTime() - Date.parse(scannedAtIso);
  if (!Number.isFinite(age) || age > CSP_SCAN_STALE_MS) return true;
  return false;
}

/**
 * Session the queued signal should be acted on. Before the cash close that is
 * today (startup catch-up). At and after the close it is the next session.
 */
export function cspTradeYmd(now: Date): string {
  const p = etParts(now);
  const close = cashSessionCloseMinute(p.year, p.month, p.day);
  if (close !== null && etMinuteOfDay(now) < close) return etYmd(now);
  const next = nextCashOpenDate(now);
  return next ? etYmd(next) : etYmd(now);
}

/** Drop today's daily bar until 10 minutes after the cash close. */
export function completedDailyBars(bars: CspDailyBar[], now: Date): CspDailyBar[] {
  if (bars.length === 0) return bars;
  const today = etYmd(now);
  const last = bars[bars.length - 1];
  if (last.ymd !== today) return bars;
  const p = etParts(now);
  const close = cashSessionCloseMinute(p.year, p.month, p.day);
  if (close === null || etMinuteOfDay(now) < close + 10) return bars.slice(0, -1);
  return bars;
}

/** True from 5 minutes before the cash close until 20 minutes after. */
export function cspAtClose(now: Date): boolean {
  const p = etParts(now);
  const close = cashSessionCloseMinute(p.year, p.month, p.day);
  if (close === null) return false;
  const minute = etMinuteOfDay(now);
  return minute >= close - 5 && minute < close + 20;
}

export function pairedBeta(stock: CspDailyBar[], spy: CspDailyBar[]): number | null {
  const bench = new Map(spy.map((b) => [b.ymd, b.close]));
  const stockCloses: number[] = [];
  const benchCloses: number[] = [];
  for (const bar of stock) {
    const b = bench.get(bar.ymd);
    if (b === undefined || !(bar.close > 0) || !(b > 0)) continue;
    stockCloses.push(bar.close);
    benchCloses.push(b);
  }
  return betaToBenchmark(dailyReturns(stockCloses), dailyReturns(benchCloses));
}

function ymdParts(ymd: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function formatYmd(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Last NYSE cash session on or before `ymd`, walking back weekends and full holidays. */
export function lastTradingYmdOnOrBefore(ymd: string): string | null {
  let cursor: string | null = ymd;
  for (let i = 0; i < 12 && cursor; i++) {
    const parts = ymdParts(cursor);
    if (!parts) return null;
    if (cashSessionCloseMinute(parts.year, parts.month, parts.day) !== null) return cursor;
    const prev = new Date(Date.UTC(parts.year, parts.month - 1, parts.day - 1));
    cursor = formatYmd(prev.getUTCFullYear(), prev.getUTCMonth() + 1, prev.getUTCDate());
  }
  return null;
}

/**
 * Eligibility beta for `now`: one value for the whole calendar month, measured
 * through the last trading day of the prior calendar month.
 */
export function monthEndBetaSpec(now: Date): { appliesTo: string; asOfYmd: string | null } {
  const p = etParts(now);
  const priorMonth = p.month === 1 ? 12 : p.month - 1;
  const priorYear = p.month === 1 ? p.year - 1 : p.year;
  const lastDay = new Date(Date.UTC(priorYear, priorMonth, 0)).getUTCDate();
  return {
    appliesTo: `${p.year}-${String(p.month).padStart(2, "0")}`,
    asOfYmd: lastTradingYmdOnOrBefore(formatYmd(priorYear, priorMonth, lastDay)),
  };
}

/**
 * 252 paired daily returns ending on `asOfYmd` (that session's return is included).
 * Same OLS as `pairedBeta` / `betaToBenchmark`. Bars after the as-of session are ignored.
 */
export function monthEndBeta(stock: CspDailyBar[], spy: CspDailyBar[], asOfYmd: string | null): number | null {
  if (!asOfYmd) return null;
  return pairedBeta(
    stock.filter((b) => b.ymd <= asOfYmd),
    spy.filter((b) => b.ymd <= asOfYmd),
  );
}

export function selectCspSignals(input: {
  names: Array<{ symbol: string; bars: CspDailyBar[] }>;
  spy: CspDailyBar[];
  earningsBySymbol: Map<string, string[] | null>;
  now: Date;
  /** Frozen month-end betas for this calendar month. Missing symbols are computed. */
  cachedBetas?: Map<string, number> | null;
}): { pending: CspPendingSignal[]; ranked: CspBetaRank[] } {
  const spec = monthEndBetaSpec(input.now);
  const ranked: CspBetaRank[] = [];
  const pending: CspPendingSignal[] = [];
  const signalYmd = input.spy.length ? input.spy[input.spy.length - 1].ymd : etYmd(input.now);
  const tradeYmd = cspTradeYmd(input.now);
  for (const name of input.names) {
    const cached = input.cachedBetas?.get(name.symbol);
    const beta =
      cached !== undefined && Number.isFinite(cached) ? cached : monthEndBeta(name.bars, input.spy, spec.asOfYmd);
    if (beta === null || !Number.isFinite(beta)) continue;
    ranked.push({ symbol: name.symbol, beta, asOfYmd: spec.asOfYmd ?? undefined });
    const signal = cspEntrySignal({ bars: name.bars, beta });
    if (!signal.ok) continue;
    const closes = name.bars.map((b) => b.close);
    pending.push({
      symbol: name.symbol,
      signalYmd,
      tradeYmd,
      swingLow: swingLowBeforeEntry(closes),
      earnings: input.earningsBySymbol.get(name.symbol) ?? null,
      beta,
      betaAsOfYmd: spec.asOfYmd ?? undefined,
    });
  }
  ranked.sort((a, b) => b.beta - a.beta);
  return { pending, ranked };
}

export function formatCspSignal(signal: CspPendingSignal): string {
  const asOf = signal.betaAsOfYmd ? ` as of ${signal.betaAsOfYmd}` : "";
  return `${signal.symbol} signal ${signal.signalYmd} for ${signal.tradeYmd} beta ${signal.beta.toFixed(2)}${asOf}`;
}

export function cspQueueDropLine(symbol: string, reason: string): string {
  return `[EventGate] csp queue drop ${symbol}: ${reason}`;
}

function normSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Drop queued signals that fail the month-end beta rule or already have a csp
 * put or assigned shares. Does not special-case any ticker. `skipBeta` keeps
 * the beta check off when bars are unavailable (the caller retries).
 */
export function revalidateQueuedSignals(input: {
  pending: CspPendingSignal[];
  betaBySymbol: Map<string, number | null>;
  openUnderlyings: Set<string>;
  asOfYmd: string | null;
  skipBeta?: boolean;
}): { pending: CspPendingSignal[]; dropped: Array<{ symbol: string; reason: string }> } {
  const open = new Set([...input.openUnderlyings].map(normSymbol));
  const betas = new Map<string, number | null>();
  for (const [symbol, beta] of input.betaBySymbol) betas.set(normSymbol(symbol), beta);
  const pending: CspPendingSignal[] = [];
  const dropped: Array<{ symbol: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const sig of input.pending) {
    const symbol = normSymbol(sig.symbol);
    if (!symbol || open.has(symbol) || seen.has(symbol)) {
      dropped.push({ symbol: sig.symbol, reason: CSP_QUEUE_DROP_OPEN });
      continue;
    }
    if (input.skipBeta) {
      seen.add(symbol);
      pending.push(sig);
      continue;
    }
    const beta = betas.has(symbol) ? betas.get(symbol)! : null;
    if (beta === null || !isHighBeta(beta)) {
      dropped.push({ symbol: sig.symbol, reason: CSP_QUEUE_DROP_BETA });
      continue;
    }
    seen.add(symbol);
    pending.push({ ...sig, beta, betaAsOfYmd: input.asOfYmd ?? sig.betaAsOfYmd });
  }
  return { pending, dropped };
}

export function parseYahooOhlcDailyBars(body: unknown): CspDailyBar[] | null {
  const root = asRecord(body);
  const chart = asRecord(root?.chart);
  const result = Array.isArray(chart?.result) ? asRecord(chart.result[0]) : null;
  if (!result) return null;
  const ts = result.timestamp;
  const indicators = asRecord(result.indicators);
  const quote = Array.isArray(indicators?.quote) ? asRecord(indicators.quote[0]) : null;
  if (!Array.isArray(ts) || !quote) return null;
  const highs = quote.high;
  const lows = quote.low;
  const closes = quote.close;
  const vols = quote.volume;
  const bars: CspDailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = numAt(ts, i);
    const high = numAt(highs, i);
    const low = numAt(lows, i);
    const close = numAt(closes, i);
    if (t === null || high === null || low === null || close === null) continue;
    const ms = t > 1e12 ? t : t * 1000;
    const volume = numAt(vols, i);
    bars.push({
      ymd: new Date(ms).toISOString().slice(0, 10),
      high,
      low,
      close,
      volume: volume !== null ? volume : 0,
    });
  }
  return bars.length ? bars : null;
}

/**
 * Yahoo quoteSummary calendarEvents. null = unknown (caller skips).
 * An earnings object with an empty earningsDate list is a known-empty calendar.
 */
export function parseYahooEarningsCalendar(body: unknown): string[] | null {
  const root = asRecord(body);
  const qs = asRecord(root?.quoteSummary);
  const result = Array.isArray(qs?.result) ? asRecord(qs.result[0]) : null;
  if (!result) return null;
  const cal = asRecord(result.calendarEvents);
  if (!cal) return null;
  const earnings = asRecord(cal.earnings);
  if (!earnings) return null;
  if (!("earningsDate" in earnings) || earnings.earningsDate == null) return null;
  const list = Array.isArray(earnings.earningsDate) ? earnings.earningsDate : [earnings.earningsDate];
  const out: string[] = [];
  for (const row of list) {
    const raw = num(asRecord(row)?.raw);
    if (raw === null) continue;
    const ms = raw > 1e12 ? raw : raw * 1000;
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

/** ^IRX prints the 13-week yield in percent. Values above 1 are scaled to a decimal. */
export function annualRateFromIrx(last: number | null): number {
  if (last === null || !Number.isFinite(last) || last < 0) return CSP_BS_RATE_FALLBACK;
  return last > 1 ? last / 100 : last;
}

export function putsFromLegs(
  legs: OptionLeg[],
  expiry: string,
  spot: number,
  asOfYmd: string,
  rate: number,
): PutQuote[] {
  const dte = calendarDte(asOfYmd, expiry);
  const out: PutQuote[] = [];
  for (const leg of legs) {
    if (leg.right !== "P" || leg.expiry !== expiry) continue;
    const resolved = resolvePutDelta(
      { strike: leg.strike, delta: leg.delta, iv: leg.iv },
      spot,
      dte ?? 45,
      rate,
    );
    out.push({
      strike: leg.strike,
      bid: leg.bid,
      ask: leg.ask,
      delta: resolved?.delta ?? leg.delta,
      iv: leg.iv,
      openInterest: leg.openInterest,
      volume: null,
      last: leg.last,
    });
  }
  return out;
}

export function candidateFromChain(input: {
  symbol: string;
  expiries: string[];
  legs: OptionLeg[];
  spot: number;
  asOfYmd: string;
  rate: number;
  earnings: string[] | null;
}): { candidate: CspCandidate | null; skip: string | null } {
  const picked = pickCspExpiry(input.expiries, input.asOfYmd);
  if (!picked) return { candidate: null, skip: "no 35–50 DTE expiry" };
  const quotes = putsFromLegs(input.legs, picked.expiry, input.spot, input.asOfYmd, input.rate);
  const strike = pickCspStrike(quotes, input.spot, picked.dte, input.rate);
  if (!strike) return { candidate: null, skip: "no 0.20 delta put" };
  const q = strike.quote;
  const earn = earningsWindowDecision(input.earnings, input.asOfYmd, picked.expiry);
  return {
    candidate: {
      underlying: input.symbol,
      expiry: picked.expiry,
      strike: q.strike,
      bid: q.bid ?? 0,
      ask: q.ask ?? 0,
      iv: q.iv,
      delta: strike.delta,
      oi: q.openInterest,
      volume: q.volume,
      signalOk: true,
      earningsOk: earn.ok,
    },
    skip: null,
  };
}

export function recorderSymbols(
  pending: string[],
  openUnderlyings: string[],
  ranked: CspBetaRank[],
  limit = CSP_RECORDER_TOP_BETA,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (symbol: string) => {
    const s = symbol.trim().toUpperCase();
    if (!s || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const s of pending) push(s);
  for (const s of openUnderlyings) push(s);
  for (const row of ranked.slice(0, limit)) push(row.symbol);
  return out;
}

export interface CspSnapshotRow {
  underlying: string;
  underlyingLast: number | null;
  expiration: string;
  strike: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
}

export function snapshotRowsFromLegs(
  underlying: string,
  spot: number | null,
  legs: OptionLeg[],
  asOfYmd: string,
  rate: number,
): CspSnapshotRow[] {
  const rows: CspSnapshotRow[] = [];
  for (const leg of legs) {
    const dte = calendarDte(asOfYmd, leg.expiry);
    const resolved =
      spot !== null
        ? resolvePutDelta({ strike: leg.strike, delta: leg.delta, iv: leg.iv }, spot, dte ?? 45, rate)
        : null;
    const delta = resolved?.delta ?? leg.delta;
    if (
      !recorderKeepsPut({
        right: leg.right,
        dte,
        strike: leg.strike,
        spot,
        delta,
      })
    ) {
      continue;
    }
    rows.push({
      underlying,
      underlyingLast: spot,
      expiration: leg.expiry,
      strike: leg.strike,
      bid: leg.bid,
      ask: leg.ask,
      last: leg.last,
      volume: null,
      openInterest: leg.openInterest,
      iv: leg.iv,
      delta,
    });
  }
  return rows;
}

export function markFromLeg(input: {
  leg: OptionLeg | null;
  spot: number | null;
  underlyingClose: number | null;
  spyClose: number | null;
  spySma200: number | null;
  dte: number | null;
}): {
  mid: number | null;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  underlyingPx: number | null;
  underlyingClose: number | null;
  spyClose: number | null;
  spySma200: number | null;
  dte: number | null;
} {
  const bid = input.leg?.bid ?? null;
  const ask = input.leg?.ask ?? null;
  const mid = bid !== null && ask !== null ? optionMid(bid, ask) : null;
  return {
    mid,
    bid,
    ask,
    delta: input.leg?.delta ?? null,
    underlyingPx: input.spot,
    underlyingClose: input.underlyingClose,
    spyClose: input.spyClose,
    spySma200: input.spySma200,
    dte: input.dte,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function numAt(v: unknown, i: number): number | null {
  if (!Array.isArray(v)) return null;
  return num(v[i]);
}
