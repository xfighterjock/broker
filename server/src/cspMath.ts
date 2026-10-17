/**
 * Pure cash-secured put math. Paper / MockBroker decisions only.
 * No broker I/O. Shadow rules never return an order.
 */

export const CSP_BETA_MIN = 1.3;
export const CSP_BETA_DAYS = 252;
export const CSP_STOCH_K = 30;
export const CSP_STOCH_SMOOTH = 5;
export const CSP_STOCH_D = 5;
export const CSP_MACD_FAST = 12;
export const CSP_MACD_SLOW = 26;
export const CSP_MACD_SIGNAL = 9;
export const CSP_TARGET_DTE = 45;
export const CSP_DTE_MIN = 35;
export const CSP_DTE_MAX = 50;
export const CSP_DELTA_TARGET = 0.2;
export const CSP_MAX_POSITIONS = 10;
export const CSP_COLLATERAL_FRAC = 0.1;
export const CSP_ONE_LOT_MAX_FRAC = 0.15;
export const CSP_MIN_BID = 0.05;
export const CSP_MIN_OPEN_INTEREST = 100;
export const CSP_MAX_SPREAD_OF_MID = 0.5;
export const CSP_STOP_MULT = 2;
/** Black-Scholes rate when the 13-week T-bill quote is missing. Documented fallback, not a fill. */
export const CSP_BS_RATE_FALLBACK = 0.04;
export const CSP_SWING_LOOKBACK = 20;

export interface OhlcBar {
  high: number;
  low: number;
  close: number;
}

export interface KdPoint {
  k: number;
  d: number;
}

export function sma(values: number[], period: number, end: number): number | null {
  if (period < 1 || end - period + 1 < 0 || end >= values.length) return null;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / period;
}

/**
 * Slow stochastic (kPeriod, kSmooth, dPeriod). Default (30, 5, 5).
 * %K raw is the close location in the lookback high/low. Slow %K is an SMA
 * of that raw value. %D is an SMA of slow %K. Null until the window fills.
 */
export function slowStochastic(
  bars: OhlcBar[],
  kPeriod = CSP_STOCH_K,
  kSmooth = CSP_STOCH_SMOOTH,
  dPeriod = CSP_STOCH_D,
): Array<KdPoint | null> {
  const raw: Array<number | null> = bars.map(() => null);
  for (let i = 0; i < bars.length; i++) {
    if (i < kPeriod - 1) continue;
    let hh = -Infinity;
    let ll = Infinity;
    let ok = true;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      const h = bars[j].high;
      const l = bars[j].low;
      if (!Number.isFinite(h) || !Number.isFinite(l)) {
        ok = false;
        break;
      }
      if (h > hh) hh = h;
      if (l < ll) ll = l;
    }
    if (!ok) continue;
    const c = bars[i].close;
    if (!Number.isFinite(c)) continue;
    const span = hh - ll;
    raw[i] = span === 0 ? 50 : ((c - ll) / span) * 100;
  }
  const slow: Array<number | null> = raw.map(() => null);
  for (let i = 0; i < raw.length; i++) {
    const window: number[] = [];
    for (let j = i - kSmooth + 1; j <= i; j++) {
      if (j < 0 || raw[j] === null) {
        window.length = 0;
        break;
      }
      window.push(raw[j] as number);
    }
    if (window.length === kSmooth) slow[i] = window.reduce((a, b) => a + b, 0) / kSmooth;
  }
  return slow.map((k, i) => {
    if (k === null) return null;
    const window: number[] = [];
    for (let j = i - dPeriod + 1; j <= i; j++) {
      if (j < 0 || slow[j] === null) return null;
      window.push(slow[j] as number);
    }
    if (window.length !== dPeriod) return null;
    const d = window.reduce((a, b) => a + b, 0) / dPeriod;
    return { k, d };
  });
}

/** %K crosses up through %D while %K is still below 20. */
export function stochCrossUpBelow20(series: Array<KdPoint | null>): boolean {
  if (series.length < 2) return false;
  const prev = series[series.length - 2];
  const cur = series[series.length - 1];
  if (!prev || !cur) return false;
  return prev.k <= prev.d && cur.k > cur.d && cur.k < 20;
}

export function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = values.map(() => null);
  if (period < 1 || values.length < period) return out;
  const seed = sma(values, period, period - 1);
  if (seed === null) return out;
  const alpha = 2 / (period + 1);
  let prev = seed;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) return out;
    prev = v * alpha + prev * (1 - alpha);
    out[i] = prev;
  }
  return out;
}

/** MACD(12, 26, 9) histogram. Null until both the slow EMA and the signal EMA exist. */
export function macdHistogram(
  closes: number[],
  fast = CSP_MACD_FAST,
  slow = CSP_MACD_SLOW,
  signal = CSP_MACD_SIGNAL,
): Array<number | null> {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macd: number[] = [];
  const macdAt: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    const f = emaFast[i];
    const s = emaSlow[i];
    if (f === null || s === null) continue;
    macd.push(f - s);
    macdAt.push(i);
  }
  const sig = emaSeries(macd, signal);
  const hist: Array<number | null> = closes.map(() => null);
  for (let i = 0; i < macd.length; i++) {
    const s = sig[i];
    if (s === null) continue;
    hist[macdAt[i]] = macd[i] - s;
  }
  return hist;
}

export function macdHistUp(hist: Array<number | null>): boolean {
  if (hist.length < 2) return false;
  const prev = hist[hist.length - 2];
  const cur = hist[hist.length - 1];
  if (prev === null || cur === null) return false;
  return cur > prev;
}

/** Trailing beta of stock daily returns vs SPY. Needs CSP_BETA_DAYS paired returns. */
export function betaToBenchmark(stockRets: number[], benchRets: number[], days = CSP_BETA_DAYS): number | null {
  const n = Math.min(stockRets.length, benchRets.length);
  if (n < days) return null;
  const s = stockRets.slice(n - days);
  const b = benchRets.slice(n - days);
  let meanS = 0;
  let meanB = 0;
  for (let i = 0; i < days; i++) {
    if (!Number.isFinite(s[i]) || !Number.isFinite(b[i])) return null;
    meanS += s[i];
    meanB += b[i];
  }
  meanS /= days;
  meanB /= days;
  let cov = 0;
  let vari = 0;
  for (let i = 0; i < days; i++) {
    const ds = s[i] - meanS;
    const db = b[i] - meanB;
    cov += ds * db;
    vari += db * db;
  }
  if (!(vari > 0)) return null;
  return cov / vari;
}

export function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    const cur = closes[i];
    if (!(prev > 0) || !Number.isFinite(cur)) continue;
    out.push(cur / prev - 1);
  }
  return out;
}

export function isHighBeta(beta: number | null, min = CSP_BETA_MIN): boolean {
  return beta !== null && Number.isFinite(beta) && beta > min;
}

/** Lowest close of the `lookback` sessions strictly before the entry bar. */
export function swingLowBeforeEntry(closes: number[], lookback = CSP_SWING_LOOKBACK): number | null {
  if (closes.length < lookback + 1) return null;
  const window = closes.slice(closes.length - 1 - lookback, closes.length - 1);
  let lo = Infinity;
  for (const c of window) {
    if (!Number.isFinite(c)) return null;
    if (c < lo) lo = c;
  }
  return Number.isFinite(lo) ? lo : null;
}

export function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function calendarDte(fromYmd: string, expiryYmd: string): number | null {
  const a = Date.parse(`${fromYmd}T00:00:00Z`);
  const b = Date.parse(`${expiryYmd}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/**
 * Earnings dates between entry and expiration, inclusive, block the trade.
 * `null` means the calendar was unknown — skip. An empty list is a known
 * empty calendar and is allowed.
 */
export function earningsWindowDecision(
  earningsYmd: string[] | null,
  entryYmd: string,
  expiryYmd: string,
): { ok: true } | { ok: false; reason: string } {
  if (earningsYmd === null) return { ok: false, reason: "earnings date unknown" };
  for (const d of earningsYmd) {
    if (d >= entryYmd && d <= expiryYmd) {
      return { ok: false, reason: `earnings ${d} between entry and expiration` };
    }
  }
  return { ok: true };
}

/** Close before an earnings date that shows up after the put is on. */
export function earningsExitDue(
  earningsYmd: string[] | null,
  todayYmd: string,
  entryYmd: string,
  expiryYmd: string,
): boolean {
  if (!earningsYmd) return false;
  return earningsYmd.some((d) => d >= entryYmd && d <= expiryYmd && d >= todayYmd);
}

export function pickCspExpiry(
  expiries: string[],
  asOfYmd: string,
  target = CSP_TARGET_DTE,
  minDte = CSP_DTE_MIN,
  maxDte = CSP_DTE_MAX,
): { expiry: string; dte: number } | null {
  let best: { expiry: string; dte: number; dist: number } | null = null;
  for (const expiry of expiries) {
    const dte = calendarDte(asOfYmd, expiry);
    if (dte === null || dte < minDte || dte > maxDte) continue;
    const dist = Math.abs(dte - target);
    if (!best || dist < best.dist || (dist === best.dist && dte > best.dte)) {
      best = { expiry, dte, dist };
    }
  }
  return best ? { expiry: best.expiry, dte: best.dte } : null;
}

/** Standard normal CDF (Abramowitz and Stegun 7.1.26). */
export function normCdf(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const t = 1 / (1 + p * Math.abs(x));
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp((-x * x) / 2);
  return 0.5 * (1 + sign * y);
}

/**
 * Black-Scholes put delta. `iv` is a decimal (0.21 = 21%). Values above 3
 * are treated as percent points. `rate` is a decimal annual risk-free rate.
 * Returns a negative number for a long put (about -0.5 at the money).
 */
export function bsPutDelta(
  spot: number,
  strike: number,
  tYears: number,
  iv: number,
  rate: number,
): number | null {
  if (!(spot > 0) || !(strike > 0) || !(tYears > 0) || !(iv > 0) || !Number.isFinite(rate)) return null;
  const vol = iv > 3 ? iv / 100 : iv;
  const s = vol * Math.sqrt(tYears);
  if (!(s > 0)) return null;
  const d1 = (Math.log(spot / strike) + (rate + (vol * vol) / 2) * tYears) / s;
  return normCdf(d1) - 1;
}

export interface PutQuote {
  strike: number;
  bid: number | null;
  ask: number | null;
  /** E*TRADE delta when the chain sent one. Signed. */
  delta: number | null;
  iv: number | null;
  openInterest: number | null;
  volume: number | null;
  last: number | null;
}

/**
 * Delta used for strike pick and probability shadows.
 * Prefer the chain Greek. Otherwise Black-Scholes from the chain IV.
 */
export function resolvePutDelta(
  quote: Pick<PutQuote, "strike" | "delta" | "iv">,
  spot: number,
  dte: number,
  rate: number,
): { delta: number; source: "etrade" | "black-scholes" } | null {
  if (quote.delta !== null && Number.isFinite(quote.delta)) {
    return { delta: quote.delta, source: "etrade" };
  }
  if (quote.iv === null || !Number.isFinite(quote.iv)) return null;
  const tYears = dte / 365;
  const delta = bsPutDelta(spot, quote.strike, tYears, quote.iv, rate);
  if (delta === null) return null;
  return { delta, source: "black-scholes" };
}

/** Strike whose |delta| is nearest 0.20. */
export function pickCspStrike(
  quotes: PutQuote[],
  spot: number,
  dte: number,
  rate: number,
  target = CSP_DELTA_TARGET,
): { quote: PutQuote; delta: number; deltaSource: "etrade" | "black-scholes" } | null {
  let best: { quote: PutQuote; delta: number; deltaSource: "etrade" | "black-scholes"; dist: number } | null =
    null;
  for (const quote of quotes) {
    const resolved = resolvePutDelta(quote, spot, dte, rate);
    if (!resolved) continue;
    const dist = Math.abs(Math.abs(resolved.delta) - target);
    if (!best || dist < best.dist - 1e-12 || (Math.abs(dist - best.dist) <= 1e-12 && quote.strike > best.quote.strike)) {
      best = { quote, delta: resolved.delta, deltaSource: resolved.source, dist };
    }
  }
  return best ? { quote: best.quote, delta: best.delta, deltaSource: best.deltaSource } : null;
}

export function optionMid(bid: number, ask: number): number | null {
  if (!(bid >= 0) || !(ask > 0) || ask < bid) return null;
  return (bid + ask) / 2;
}

/**
 * Sell-to-open fill: max(bid, mid - 0.25 * spread).
 * Skip when bid <= 0.05 or the spread is wider than half the mid.
 * Open interest is checked by the caller.
 */
export function cspSellFill(
  bid: number | null,
  ask: number | null,
): { ok: true; fill: number; mid: number; spread: number } | { ok: false; reason: string } {
  if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask)) {
    return { ok: false, reason: "missing bid/ask" };
  }
  if (bid <= CSP_MIN_BID) return { ok: false, reason: "bid <= 0.05" };
  const mid = optionMid(bid, ask);
  if (mid === null || !(mid > 0)) return { ok: false, reason: "bad quote" };
  const spread = ask - bid;
  if (spread > CSP_MAX_SPREAD_OF_MID * mid) return { ok: false, reason: "spread > 50% of mid" };
  const fill = Math.max(bid, mid - 0.25 * spread);
  return { ok: true, fill, mid, spread };
}

/** Buy-to-close fill used by the live 2x stop and by every shadow exit. */
export function cspBuyFill(bid: number | null, ask: number | null, midFallback: number | null): number | null {
  if (bid === null || ask === null || !Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid) {
    return midFallback !== null && Number.isFinite(midFallback) ? midFallback : null;
  }
  const mid = optionMid(bid, ask);
  if (mid === null) return midFallback;
  const spread = ask - bid;
  return Math.min(ask, mid + 0.25 * spread);
}

export function openInterestOk(oi: number | null, min = CSP_MIN_OPEN_INTEREST): boolean {
  return oi !== null && Number.isFinite(oi) && oi >= min;
}

export interface SizeInput {
  equityUsd: number;
  reservedUsd: number;
  assignedMvUsd: number;
  strike: number;
  openPutCount: number;
}

/**
 * Whole contracts, about 10% of equity of collateral each, never more than
 * the cash that is still free. One contract above 15% of equity is skipped.
 * reserved + assigned market value never exceeds equity.
 */
export function sizeCashSecuredPut(
  input: SizeInput,
): { ok: true; contracts: number; reservedUsd: number } | { ok: false; reason: string } {
  const { equityUsd, reservedUsd, assignedMvUsd, strike, openPutCount } = input;
  if (!(equityUsd > 0) || !Number.isFinite(equityUsd)) return { ok: false, reason: "no equity" };
  if (openPutCount >= CSP_MAX_POSITIONS) return { ok: false, reason: "max 10 positions" };
  const per = strike * 100;
  if (!(per > 0) || !Number.isFinite(per)) return { ok: false, reason: "bad strike" };
  if (per > equityUsd * CSP_ONE_LOT_MAX_FRAC) {
    return { ok: false, reason: "1 contract > 15% of equity" };
  }
  const room = equityUsd - reservedUsd - assignedMvUsd;
  if (!(room > 0)) return { ok: false, reason: "cash rule: reserved + assigned would exceed equity" };
  const maxByRoom = Math.floor(room / per + 1e-9);
  if (maxByRoom < 1) return { ok: false, reason: "cash rule: reserved + assigned would exceed equity" };
  let contracts = Math.floor((equityUsd * CSP_COLLATERAL_FRAC) / per);
  if (contracts < 1) contracts = 1;
  contracts = Math.min(contracts, maxByRoom);
  const reserved = per * contracts;
  if (reservedUsd + assignedMvUsd + reserved > equityUsd + 1e-6) {
    return { ok: false, reason: "cash rule: reserved + assigned would exceed equity" };
  }
  return { ok: true, contracts, reservedUsd: reserved };
}

export function collateralInvariant(reservedUsd: number, assignedMvUsd: number, equityUsd: number): boolean {
  return reservedUsd + assignedMvUsd <= equityUsd + 1e-6;
}

export function twoXStopHit(mid: number | null, entryPremium: number): boolean {
  if (mid === null || !Number.isFinite(mid) || !(entryPremium > 0)) return false;
  return mid >= CSP_STOP_MULT * entryPremium;
}

/** ITM put (underlying strictly below the strike) assigns. ATM and OTM expire. */
export function putExpiresItm(underlyingPx: number, strike: number): boolean {
  return Number.isFinite(underlyingPx) && Number.isFinite(strike) && underlyingPx < strike;
}

export function shortPutPnlPerContract(entryPremium: number, exitPremium: number): number {
  return (entryPremium - exitPremium) * 100;
}

export function assignmentIntrinsic(underlyingPx: number, strike: number): number {
  return Math.max(strike - underlyingPx, 0);
}

/** One calendar day of T-bill accrual on idle cash plus reserved collateral. */
export function tbillDayAccrual(cashUsd: number, annualRate: number): number {
  if (!(cashUsd > 0) || !Number.isFinite(annualRate) || annualRate < 0) return 0;
  return (cashUsd * annualRate) / 365;
}

export const CSP_SHADOW_RULES = [
  "tp50",
  "dte21",
  "combined",
  "tp75",
  "swing_low",
  "spy_200",
  "7",
  "8",
  "7+2x",
  "8+2x",
  "7+8+2x",
  "7d03",
  "8d40",
  "7d03+2x",
  "8d40+2x",
  "7d03+8d40+2x",
] as const;

export type CspShadowRuleId = (typeof CSP_SHADOW_RULES)[number];

export interface ShadowMarket {
  /** Put mid. */
  mid: number | null;
  bid: number | null;
  ask: number | null;
  /** Signed put delta. Null when neither the chain nor Black-Scholes could price it. */
  delta: number | null;
  dte: number | null;
  underlyingPx: number | null;
  /** Official close, set on the close check only. */
  underlyingClose: number | null;
  spyClose: number | null;
  spySma200: number | null;
  atClose: boolean;
  entryCredit: number;
  swingLow: number | null;
}

export interface ShadowRow {
  positionId: string;
  ruleId: CspShadowRuleId;
  triggeredAt: string | null;
  underlyingPx: number | null;
  putBid: number | null;
  putAsk: number | null;
  putMid: number | null;
  fill: number | null;
  pnl: number | null;
  finalActualPnl: number | null;
}

function creditCaptured(mid: number, entry: number, keepFrac: number): boolean {
  return mid <= keepFrac * entry;
}

function rule7(m: ShadowMarket, deltaMax: number): boolean {
  if (m.delta === null || m.mid === null || !(m.entryCredit > 0)) return false;
  return Math.abs(m.delta) <= deltaMax && creditCaptured(m.mid, m.entryCredit, 0.25);
}

function rule8(m: ShadowMarket, deltaMin: number): boolean {
  if (m.delta === null) return false;
  return Math.abs(m.delta) >= deltaMin;
}

function hit2x(m: ShadowMarket): boolean {
  return twoXStopHit(m.mid, m.entryCredit);
}

/** True when this shadow rule would hypothetically exit. Never an order. */
export function shadowRuleHit(rule: CspShadowRuleId, m: ShadowMarket): boolean {
  const entry = m.entryCredit;
  const mid = m.mid;
  switch (rule) {
    case "tp50":
      return mid !== null && entry > 0 && creditCaptured(mid, entry, 0.5);
    case "dte21":
      return m.dte !== null && m.dte <= 21;
    case "combined":
      return (
        (mid !== null && entry > 0 && creditCaptured(mid, entry, 0.5)) ||
        (m.dte !== null && m.dte <= 21) ||
        hit2x(m)
      );
    case "tp75":
      return mid !== null && entry > 0 && creditCaptured(mid, entry, 0.25);
    case "swing_low":
      return (
        m.atClose &&
        m.underlyingClose !== null &&
        m.swingLow !== null &&
        m.underlyingClose < m.swingLow
      );
    case "spy_200":
      return (
        m.atClose &&
        m.spyClose !== null &&
        m.spySma200 !== null &&
        m.spyClose < m.spySma200
      );
    case "7":
      return rule7(m, 0.05);
    case "8":
      return rule8(m, 0.5);
    case "7+2x":
      return rule7(m, 0.05) || hit2x(m);
    case "8+2x":
      return rule8(m, 0.5) || hit2x(m);
    case "7+8+2x":
      return rule7(m, 0.05) || rule8(m, 0.5) || hit2x(m);
    case "7d03":
      return rule7(m, 0.03);
    case "8d40":
      return rule8(m, 0.4);
    case "7d03+2x":
      return rule7(m, 0.03) || hit2x(m);
    case "8d40+2x":
      return rule8(m, 0.4) || hit2x(m);
    case "7d03+8d40+2x":
      return rule7(m, 0.03) || rule8(m, 0.4) || hit2x(m);
    default:
      return false;
  }
}

function blankShadow(positionId: string, ruleId: CspShadowRuleId): ShadowRow {
  return {
    positionId,
    ruleId,
    triggeredAt: null,
    underlyingPx: null,
    putBid: null,
    putAsk: null,
    putMid: null,
    fill: null,
    pnl: null,
    finalActualPnl: null,
  };
}

/**
 * Record the first trigger of each shadow rule. Does not emit orders.
 * Rows that already triggered are left alone.
 */
export function applyShadowCheck(
  rows: ShadowRow[],
  positionId: string,
  market: ShadowMarket,
  nowIso: string,
): ShadowRow[] {
  const byRule = new Map(rows.filter((r) => r.positionId === positionId).map((r) => [r.ruleId, r]));
  const others = rows.filter((r) => r.positionId !== positionId);
  const next: ShadowRow[] = [];
  for (const ruleId of CSP_SHADOW_RULES) {
    const prev = byRule.get(ruleId) ?? blankShadow(positionId, ruleId);
    if (prev.triggeredAt || !shadowRuleHit(ruleId, market)) {
      next.push(prev);
      continue;
    }
    const fill = cspBuyFill(market.bid, market.ask, market.mid);
    next.push({
      ...prev,
      triggeredAt: nowIso,
      underlyingPx: market.underlyingPx,
      putBid: market.bid,
      putAsk: market.ask,
      putMid: market.mid,
      fill,
      pnl: fill === null ? null : shortPutPnlPerContract(market.entryCredit, fill),
    });
  }
  return [...others, ...next];
}

/**
 * When the live put closes or expires, stamp actual P/L on every rule.
 * A rule that never triggered keeps the actual exit (same economics).
 */
export function settleShadowActual(
  rows: ShadowRow[],
  positionId: string,
  actualPnlPerContract: number,
  actualFill: number | null,
  market: ShadowMarket,
  nowIso: string,
): ShadowRow[] {
  const seeded = applyShadowCheck(rows, positionId, { ...market, mid: market.mid }, nowIso);
  return seeded.map((r) => {
    if (r.positionId !== positionId) return r;
    if (r.triggeredAt) return { ...r, finalActualPnl: actualPnlPerContract };
    return {
      ...r,
      underlyingPx: r.underlyingPx ?? market.underlyingPx,
      putBid: r.putBid ?? market.bid,
      putAsk: r.putAsk ?? market.ask,
      putMid: r.putMid ?? market.mid,
      fill: actualFill,
      pnl: actualPnlPerContract,
      finalActualPnl: actualPnlPerContract,
    };
  });
}

export interface CspShadowSummary {
  ruleId: CspShadowRuleId;
  count: number;
  wins: number;
  winRate: number | null;
  totalPnl: number;
  avgPnl: number | null;
  totalVsActual: number;
  avgVsActual: number | null;
}

export function summarizeShadowExits(rows: ShadowRow[]): CspShadowSummary[] {
  return CSP_SHADOW_RULES.map((ruleId) => {
    const scored = rows.filter((r) => {
      if (r.ruleId !== ruleId || r.pnl === null || !Number.isFinite(r.pnl)) return false;
      return r.triggeredAt !== null || r.finalActualPnl !== null;
    });
    const count = scored.length;
    const wins = scored.filter((r) => (r.pnl as number) > 0).length;
    const totalPnl = scored.reduce((s, r) => s + (r.pnl as number), 0);
    const compared = scored.filter((r) => r.finalActualPnl !== null && Number.isFinite(r.finalActualPnl));
    const totalVsActual = compared.reduce(
      (s, r) => s + ((r.pnl as number) - (r.finalActualPnl as number)),
      0,
    );
    return {
      ruleId,
      count,
      wins,
      winRate: count ? wins / count : null,
      totalPnl,
      avgPnl: count ? totalPnl / count : null,
      totalVsActual,
      avgVsActual: compared.length ? totalVsActual / compared.length : null,
    };
  });
}

/** Recorder keep-rule: puts, 25–60 DTE, |delta| 0.05–0.50, else 70% of spot through ATM. */
export function recorderKeepsPut(input: {
  right: "C" | "P";
  dte: number | null;
  strike: number;
  spot: number | null;
  delta: number | null;
}): boolean {
  if (input.right !== "P") return false;
  if (input.dte === null || input.dte < 25 || input.dte > 60) return false;
  if (input.delta !== null && Number.isFinite(input.delta)) {
    const mag = Math.abs(input.delta);
    return mag >= 0.05 - 1e-9 && mag <= 0.5 + 1e-9;
  }
  if (input.spot === null || !(input.spot > 0)) return false;
  return input.strike <= input.spot + 1e-9 && input.strike >= input.spot * 0.7 - 1e-9;
}

export interface CspSignalInput {
  bars: OhlcBar[];
  beta: number | null;
}

/** Daily-close signal. No 200-day filter. */
export function cspEntrySignal(input: CspSignalInput): { ok: true } | { ok: false; reason: string } {
  if (!isHighBeta(input.beta)) return { ok: false, reason: "beta <= 1.3 or unknown" };
  const stoch = slowStochastic(input.bars);
  if (!stochCrossUpBelow20(stoch)) return { ok: false, reason: "no stochastic cross below 20" };
  const closes = input.bars.map((b) => b.close);
  if (!macdHistUp(macdHistogram(closes))) return { ok: false, reason: "MACD histogram not up" };
  return { ok: true };
}

export interface CspPlanQuote {
  underlying: string;
  expiry: string;
  strike: number;
  bid: number;
  ask: number;
  iv: number | null;
  delta: number | null;
  oi: number | null;
  volume: number | null;
}

/**
 * New cash-secured put. `riskOn` is accepted so callers can pass the regime
 * flag, and it is not read as a gate. RISK ON, RISK OFF, the 200-day checks,
 * and the dollar veto do not block this sleeve.
 */
export interface CspPlanInput {
  riskOn: boolean;
  autoOn: boolean;
  gateEnabled: boolean;
  gateMode: "idle" | "PRE-ARM" | "NO-STOP BAND" | "SESSION FLATTEN";
  inCashSession: boolean;
  chainAvailable: boolean;
  lossCapHit: boolean;
  equityUsd: number;
  reservedUsd: number;
  assignedMvUsd: number;
  openPutCount: number;
  signalOk: boolean;
  /** False when earnings are unknown or any date falls in the entry-to-expiry window. */
  earningsOk: boolean;
  quote: CspPlanQuote | null;
}

export interface CspPlannedEntry {
  underlying: string;
  expiry: string;
  strike: number;
  contracts: number;
  fill: number;
  reservedUsd: number;
  bid: number;
  ask: number;
  mid: number;
  iv: number | null;
  delta: number | null;
  oi: number | null;
  volume: number | null;
}

export function planCspEntry(
  input: CspPlanInput,
): { entry: CspPlannedEntry | null; skip: string | null } {
  // Regime is intentionally unused. Do not add a riskOn / 200-day / dollar-veto branch here.
  void input.riskOn;
  if (!input.autoOn) return { entry: null, skip: "csp auto off" };
  if (!input.gateEnabled) return { entry: null, skip: "GATE OFF" };
  if (input.gateMode !== "idle") return { entry: null, skip: `gate ${input.gateMode}` };
  if (!input.inCashSession) return { entry: null, skip: "outside cash session" };
  if (!input.chainAvailable) return { entry: null, skip: "E*TRADE chain unavailable" };
  if (input.lossCapHit) return { entry: null, skip: "sleeve loss cap" };
  if (!input.signalOk) return { entry: null, skip: "no signal" };
  if (!input.earningsOk) return { entry: null, skip: "earnings unknown or inside window" };
  const q = input.quote;
  if (!q) return { entry: null, skip: "no contract" };
  const mid = optionMid(q.bid, q.ask);
  if (mid === null) return { entry: null, skip: "no mid" };
  if (!(q.bid > CSP_MIN_BID)) return { entry: null, skip: "bid <= 0.05" };
  if (!openInterestOk(q.oi)) return { entry: null, skip: "open interest < 100" };
  const spread = q.ask - q.bid;
  if (!(mid > 0) || spread > mid * CSP_MAX_SPREAD_OF_MID) return { entry: null, skip: "spread > 50% of mid" };
  const sold = cspSellFill(q.bid, q.ask);
  if (!sold.ok) return { entry: null, skip: sold.reason };
  const fill = sold.fill;
  const sized = sizeCashSecuredPut({
    equityUsd: input.equityUsd,
    reservedUsd: input.reservedUsd,
    assignedMvUsd: input.assignedMvUsd,
    strike: q.strike,
    openPutCount: input.openPutCount,
  });
  if (!sized.ok) return { entry: null, skip: sized.reason };
  if (!collateralInvariant(input.reservedUsd + sized.reservedUsd, input.assignedMvUsd, input.equityUsd)) {
    return { entry: null, skip: "cash rule: reserved + assigned would exceed equity" };
  }
  return {
    entry: {
      underlying: q.underlying,
      expiry: q.expiry,
      strike: q.strike,
      contracts: sized.contracts,
      fill,
      reservedUsd: sized.reservedUsd,
      bid: q.bid,
      ask: q.ask,
      mid,
      iv: q.iv,
      delta: q.delta,
      oi: q.oi,
      volume: q.volume,
    },
    skip: null,
  };
}
