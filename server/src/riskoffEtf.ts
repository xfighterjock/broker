import { etParts, pad2 } from "../../shared/clock";
import {
  DEFAULT_SLEEVE_EQUITY_USD,
  RISKOFF_ETF_CANDIDATES,
  RISKOFF_ETF_CASH_SYMBOL,
  RISKOFF_ETF_COMMODITY_BETA,
  RISKOFF_ETF_CTA_CONFIRM_DAYS,
  RISKOFF_ETF_CTA_FAMILY,
  RISKOFF_ETF_GOLD_FAMILY,
  RISKOFF_ETF_HYG_ONLY_21D_CONFIRM,
  RISKOFF_ETF_HYG_ONLY_INELIGIBLE,
  RISKOFF_ETF_LOOKBACK_DAYS,
  RISKOFF_ETF_MIN_HOLD_SESSIONS,
  RISKOFF_ETF_MISSING_BARS_MAX_MISSES,
  RISKOFF_ETF_NOTIONAL_FRAC,
  RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED,
  RISKOFF_ETF_REQUIRE_ABOVE_200,
  RISKOFF_ETF_RESIZE_NOTIONAL_FRAC,
  RISKOFF_ETF_RS_HYSTERESIS,
  RISKOFF_ETF_STOP_MUL,
  RISKOFF_ETF_SYMBOLS,
  RISKOFF_ETF_TOP_N,
  type RiskoffEtfSymbol,
} from "../../shared/constants";
import { cashSessionCloseMinute } from "../../shared/marketSession";
import type { Position, SleeveCard } from "../../shared/types";
import { fetchMassiveDailyBars, type DailyBar } from "./massive";

export type RiskoffEtfReturns = Record<RiskoffEtfSymbol, number | null>;
/** Own-200 vs last close. Null = short/missing series (fail closed). BIL is unused. */
export type RiskoffEtfAbove200 = Record<RiskoffEtfSymbol, boolean | null>;

export type RiskoffEtfOverlaySnapshot = {
  /** 63d total returns. Incomplete universe → missing-bars debounce. */
  returns: RiskoffEtfReturns;
  /**
   * RISKOFF_ETF_CTA_CONFIRM_DAYS total returns from the same dailies.
   * CTA confirmation always. In HYG-only RISK OFF the same map confirms
   * gold-family names and RISKOFF_ETF_HYG_ONLY_21D_CONFIRM.
   * A missing name does not debounce the overlay.
   */
  returns21: RiskoffEtfReturns;
  above200: RiskoffEtfAbove200;
};

export type RiskoffEtfBuy = {
  sleeveId: "riskoff";
  symbol: RiskoffEtfSymbol;
  side: "Buy";
  qty: number;
  stopPrice: number;
  thesis: string;
};

export type RiskoffEtfSell = {
  sleeveId: "riskoff";
  symbol: string;
  reason: string;
};

export type RiskoffEtfCandidate = (typeof RISKOFF_ETF_CANDIDATES)[number];

export type RiskoffEtfDecision = {
  /** RS #1 (or BIL). Duration and older callers use this as the primary name. */
  winner: RiskoffEtfSymbol | null;
  /** 1–2 overlay names (or `[BIL]`). Empty when flattened with no target. */
  winners: RiskoffEtfSymbol[];
  reason: string;
  sells: RiskoffEtfSell[];
  /** First new buy; prefer `buys` when two names open. */
  buy: RiskoffEtfBuy | null;
  buys: RiskoffEtfBuy[];
};

/** Consecutive missing-bars / incomplete-returns decisions. Process-local. */
let missingBarsMisses = 0;
/** NY date (YYYY-MM-DD) of the last cash-close RS rebalance. Process-local. */
let lastRebalanceYmd: string | null = null;
/** Sleeve to restore after an intraday missing-bars flatten, until the next cash-close rebalance. */
let priorOverlayTargets: RiskoffEtfSymbol[] = [];
/** Set when missing bars flatten an open sleeve. Cleared by RISK ON, loss cap, or a cash-close rebalance. */
let pendingPriorRebuy = false;
/** NY session date an overlay candidate was entered. BIL is not tracked. Process-local. */
const entrySessionBySymbol = new Map<string, string>();

export function getRiskoffEtfMissingBarsMisses(): number {
  return missingBarsMisses;
}

/** Clears missing-bars streak and the overlay rebalance clock (entry sessions, prior rebuy, last close). */
export function resetRiskoffEtfMissingBarsMisses(): void {
  missingBarsMisses = 0;
  lastRebalanceYmd = null;
  priorOverlayTargets = [];
  pendingPriorRebuy = false;
  entrySessionBySymbol.clear();
}

export function riskoffEtfNyYmd(now: Date): string {
  const p = etParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

function parseYmd(ymd: string): { year: number; month: number; day: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/**
 * Minute-of-day of the NY cash close, or null on weekends and full holidays.
 * Early-close days close at 13:00 ET. A non-null result means the date is a
 * trading session for the overlay hold clock.
 */
export function riskoffEtfCashCloseMinute(year: number, month: number, day: number): number | null {
  return cashSessionCloseMinute(year, month, day);
}

/** True at or after today's NY cash close, and not yet rebalanced this session. */
export function riskoffEtfRebalanceDue(now: Date, lastYmd: string | null): boolean {
  const p = etParts(now);
  const closeMin = riskoffEtfCashCloseMinute(p.year, p.month, p.day);
  if (closeMin === null) return false;
  if (p.hour * 60 + p.minute < closeMin) return false;
  return lastYmd !== riskoffEtfNyYmd(now);
}

/**
 * Inclusive count of NY cash sessions from the entry date through asOf.
 * Weekends and full holidays do not count. Early-close days do.
 * Entry session is 1. A name may be RS-rotated off once this is >= 
 * RISKOFF_ETF_MIN_HOLD_SESSIONS.
 */
export function riskoffEtfSessionsHeld(entryYmd: string, asOfYmd: string): number {
  const start = parseYmd(entryYmd);
  const end = parseYmd(asOfYmd);
  if (!start || !end) return 0;
  let t = Date.UTC(start.year, start.month - 1, start.day);
  const endT = Date.UTC(end.year, end.month - 1, end.day);
  if (endT < t) return 0;
  let n = 0;
  while (t <= endT) {
    const d = new Date(t);
    if (riskoffEtfCashCloseMinute(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()) !== null) {
      n += 1;
    }
    t += 86_400_000;
  }
  return n;
}

export function isRiskoffEtfCta(symbol: string): boolean {
  return (RISKOFF_ETF_CTA_FAMILY as readonly string[]).includes(symbol.trim().toUpperCase());
}

export function isRiskoffEtfGold(symbol: string): boolean {
  return (RISKOFF_ETF_GOLD_FAMILY as readonly string[]).includes(symbol.trim().toUpperCase());
}

/** CLSE, USMV, QUAL, FTLS. Not CTA and not gold. */
export function isRiskoffEtfHygOnly21dConfirm(symbol: string): boolean {
  return (RISKOFF_ETF_HYG_ONLY_21D_CONFIRM as readonly string[]).includes(symbol.trim().toUpperCase());
}

/** TLT, IEF, XLU, PDBC, KMLM, GDX. RS-ineligible in HYG-only only. KMLM stays CTA. GDX stays gold-family. GLD is not in this set. DBMF is not in this set. Not a duration-book change. */
export function isRiskoffEtfHygOnlyIneligible(symbol: string): boolean {
  return (RISKOFF_ETF_HYG_ONLY_INELIGIBLE as readonly string[]).includes(symbol.trim().toUpperCase());
}

/** PDBC only. Commodity beta, not a CTA and not 21d-gated. HYG-only RS-ineligible. */
export function isRiskoffEtfCommodityBeta(symbol: string): boolean {
  return symbol.trim().toUpperCase() === RISKOFF_ETF_COMMODITY_BETA;
}

/** True when one name is PDBC and the other is in RISKOFF_ETF_CTA_FAMILY. */
function riskoffEtfPdbcCtaConflict(a: string, b: string): boolean {
  const leftPdbc = isRiskoffEtfCommodityBeta(a);
  const rightPdbc = isRiskoffEtfCommodityBeta(b);
  if (leftPdbc === rightPdbc) return false;
  return (leftPdbc && isRiskoffEtfCta(b)) || (rightPdbc && isRiskoffEtfCta(a));
}

export function isRiskoffEtfSymbol(symbol: string): symbol is RiskoffEtfSymbol {
  return (RISKOFF_ETF_SYMBOLS as readonly string[]).includes(symbol.trim().toUpperCase());
}

export function emptyRiskoffEtfReturns(): RiskoffEtfReturns {
  const out = {} as RiskoffEtfReturns;
  for (const s of RISKOFF_ETF_SYMBOLS) out[s] = null;
  return out;
}

export function emptyRiskoffEtfAbove200(): RiskoffEtfAbove200 {
  const out = {} as RiskoffEtfAbove200;
  for (const s of RISKOFF_ETF_SYMBOLS) out[s] = null;
  return out;
}

/** Exact lookback only. Short or missing series → null (fail closed). */
export function periodReturn(closes: number[], period: number): number | null {
  const n = closes.length;
  if (n <= period) return null;
  const last = closes[n - 1];
  const base = closes[n - 1 - period];
  if (!(last > 0) || !(base > 0)) return null;
  return last / base - 1;
}

export function closesFromBars(bars: DailyBar[] | null | undefined): number[] {
  if (!bars) return [];
  const closes: number[] = [];
  for (const b of bars) {
    if (typeof b.close === "number" && Number.isFinite(b.close) && b.close > 0) {
      closes.push(b.close);
    }
  }
  return closes;
}

export function riskoffEtfReturnFromBars(
  bars: DailyBar[] | null | undefined,
  period = RISKOFF_ETF_LOOKBACK_DAYS,
): number | null {
  return periodReturn(closesFromBars(bars), period);
}

export function riskoffEtfReturnsFromBars(
  bars: Partial<Record<RiskoffEtfSymbol, DailyBar[] | null | undefined>>,
  period = RISKOFF_ETF_LOOKBACK_DAYS,
): RiskoffEtfReturns {
  const out = emptyRiskoffEtfReturns();
  for (const s of RISKOFF_ETF_SYMBOLS) {
    out[s] = riskoffEtfReturnFromBars(bars[s], period);
  }
  return out;
}

/** 200-day SMA from overlay daily closes. Need 200 finite closes; never invents. */
export function above200FromCloses(closes: number[]): boolean | null {
  if (closes.length < 200) return null;
  const window = closes.slice(-200);
  let sum = 0;
  for (const c of window) {
    if (!(c > 0) || !Number.isFinite(c)) return null;
    sum += c;
  }
  const sma200 = sum / 200;
  const last = closes[closes.length - 1];
  if (!(sma200 > 0) || !(last > 0)) return null;
  return last > sma200;
}

export function riskoffEtfAbove200FromBars(
  bars: Partial<Record<RiskoffEtfSymbol, DailyBar[] | null | undefined>>,
): RiskoffEtfAbove200 {
  const out = emptyRiskoffEtfAbove200();
  for (const s of RISKOFF_ETF_SYMBOLS) {
    out[s] = above200FromCloses(closesFromBars(bars[s]));
  }
  return out;
}

function absoluteTrendParkReason(
  rsWinner: RiskoffEtfSymbol,
  above200: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null | undefined,
): string {
  if (above200?.[rsWinner] === false) return `${rsWinner} below 200dma: overlay cash`;
  return `${rsWinner} 200dma missing: overlay cash`;
}

/**
 * After RS + hysteresis, park a candidate in BIL unless it is known above
 * its own 200dma. BIL is never 200-filtered.
 */
export function applyRiskoffEtfAbsoluteTrend(
  rsWinner: RiskoffEtfSymbol | null,
  above200?: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null,
): RiskoffEtfSymbol | null {
  if (rsWinner === null || rsWinner === RISKOFF_ETF_CASH_SYMBOL) return rsWinner;
  if (!RISKOFF_ETF_REQUIRE_ABOVE_200) return rsWinner;
  if (above200?.[rsWinner] === true) return rsWinner;
  return RISKOFF_ETF_CASH_SYMBOL;
}

/**
 * Overlay book fraction from the same spyAbove200 used to gate equity/credit
 * puts. SPY known above 200 → 60% (puts gated). SPY below 200 or missing →
 * 40% (do not scale up without the signal). RISK ON still flattens first.
 */
export function riskoffEtfNotionalFrac(spyAbove200?: boolean | null): number {
  return spyAbove200 === true ? RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED : RISKOFF_ETF_NOTIONAL_FRAC;
}

export function riskoffEtfSleeveFrac(
  nameCount: number,
  totalFrac = RISKOFF_ETF_NOTIONAL_FRAC,
): number {
  if (nameCount >= RISKOFF_ETF_TOP_N) return totalFrac / RISKOFF_ETF_TOP_N;
  return totalFrac;
}

/** True when a held overlay lot is materially off the current 40/60 target. */
export function overlayLotNeedsResize(heldQty: number, targetQty: number, last: number): boolean {
  if (!(heldQty >= 0) || !(targetQty >= 0)) return false;
  if (heldQty === targetQty) return false;
  if (targetQty < 1) return heldQty > 0;
  if (heldQty < 1) return targetQty >= 1;
  if (!(last > 0) || !Number.isFinite(last)) return heldQty !== targetQty;
  return Math.abs(heldQty - targetQty) * last >= DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_RESIZE_NOTIONAL_FRAC;
}

export function riskoffEtfReturnsReady(returns: RiskoffEtfReturns): boolean {
  for (const s of RISKOFF_ETF_SYMBOLS) {
    const r = returns[s];
    if (r === null || !Number.isFinite(r)) return false;
  }
  return true;
}

/**
 * Hold a candidate if that name's lookback return beats BIL; else BIL.
 * Any missing overlay-universe return → null (not an RS pick; decideRiskoffEtf
 * debounces flatten — hysteresis does not apply until returns are ready).
 * Among names that beat BIL, pick the highest 63d return. If a held name is still eligible, keep it
 * unless a challenger leads by RISKOFF_ETF_RS_HYSTERESIS or more. Exact RS
 * tie keeps a held name when it is still eligible, else preference order
 * GLD > GDX > PDBC > UUP > TLT > IEF > FLOT > XLU > XLP > DBMF > KMLM > CLSE > USMV > QUAL > FTLS > BTAL. Hysteresis does not apply
 * when held is missing, not an overlay candidate, or ineligible (return ≤ BIL).
 * Pass above200 to treat own-200 as a qualifier filter (beat BIL and above
 * 200); omit it to test RS/hysteresis in isolation. Names that fail 200 are
 * skipped; if none qualify → BIL. BIL itself is never 200-filtered.
 * While RISK OFF, pickRiskoffEtfSleeve then takes the top-2 qualifiers at
 * 50/50 overlay notional (one non-gold non-CTA name at full size; a lone
 * CTA or a lone gold name is 50/50 with BIL; none → BIL). Overlay
 * notional is 60% while spyAbove200 === true (puts gated) and 40% when SPY
 * is below 200. When #1 is in RISKOFF_ETF_CTA_FAMILY, #2 is the highest
 * non-CTA qualifier other than PDBC (a gold name may fill that slot). If
 * none clears beat-BIL and own-200, #2 is BIL at 50/50 — never two CTAs
 * (no KMLM+DBMF) and never PDBC beside that CTA. A lone CTA is still
 * 50/50 with BIL, not the full overlay. When #1 is in
 * RISKOFF_ETF_GOLD_FAMILY, #2 is the highest non-gold qualifier (a CTA may
 * fill that slot if it cleared the 21d gate; PDBC may fill it). If none
 * does, #2 is BIL at 50/50 — never GLD+GDX. A lone gold name is 50/50
 * with BIL. When #1 is RISKOFF_ETF_COMMODITY_BETA (PDBC), #2 is the
 * highest qualifier outside the CTA family. If none clears, #2 is BIL at
 * 50/50 — never PDBC+DBMF or PDBC+KMLM. When PDBC is eligible, a lone PDBC
 * (no other qualifier) stays full size. HYG-only does not open that sleeve.
 * CTA filter runs first, then gold, then the PDBC↔CTA
 * exclusion, if a name were ever in both CTA and gold. Pass returns21 to also require each CTA-family
 * name to beat BIL on RISKOFF_ETF_CTA_CONFIRM_DAYS (strict >; missing bars
 * fail closed for that CTA only). Omit returns21 to test 63d RS in
 * isolation. FLOT, XLP, and BTAL ignore returns21. PDBC ignores returns21
 * too, but HYG-only drops it via RISKOFF_ETF_HYG_ONLY_INELIGIBLE. KMLM does
 * not ignore returns21 (always-on CTA confirm) and HYG-only still drops it
 * through that same set. GDX does not ignore the HYG-only gold 21d window
 * when that gate is on, and HYG-only still drops it through that same set.
 * Gold-family membership is unchanged. GLD is not in the drop and stays
 * eligible when the HYG-only gold 21d beat-BIL passes. DBMF keeps the 21d
 * confirm and stays eligible in HYG-only. Pass hygOnly
 * (HYG-only RISK OFF: risk off, SPY known above 200, HYG known below 200)
 * to also require each RISKOFF_ETF_GOLD_FAMILY name and each
 * RISKOFF_ETF_HYG_ONLY_21D_CONFIRM name (CLSE, USMV, QUAL, FTLS) to beat
 * BIL on that same 21d window; missing bars fail that name closed. The
 * same flag drops RISKOFF_ETF_HYG_ONLY_INELIGIBLE (TLT, IEF, XLU, PDBC, KMLM, GDX)
 * from the RS basket even when 63d beats BIL. That PDBC drop blocks a
 * lone-PDBC full overlay and a PDBC+FTLS sleeve. The KMLM drop blocks the
 * same qualifier-conditional path: 63d beat-BIL, own-200, and the CTA 21d
 * confirm do not qualify KMLM in HYG-only. KMLM stays in
 * RISKOFF_ETF_CTA_FAMILY for never-dual-CTA and that 21d confirm when it is
 * eligible. The GDX drop is the same path: 63d beat-BIL, own-200, and the
 * HYG-only gold 21d beat-BIL do not qualify GDX. GDX stays in
 * RISKOFF_ETF_GOLD_FAMILY for never-dual-gold and for SPY-under-200
 * eligibility. GLD stays eligible with that 21d beat-BIL. DBMF is unchanged.
 * Omit hygOnly and gold, the equity
 * confirm set, and that drop stay off, including when SPY is below 200.
 * PDBC is never 21d-gated; in HYG-only it is not a qualifier at all. KMLM
 * is 21d-gated whenever it is eligible, and in HYG-only it is not a
 * qualifier at all. GDX is 21d-gated only in HYG-only, and in that regime
 * it is not a qualifier at all. A failed CTA, a gold or equity name that fails
 * the HYG-only 21d check, or a HYG-only-ineligible name is dropped from
 * the ranked basket; the next remaining qualifier fills the slot. None
 * left → BIL. The drop does not change the gated duration book.
 * RS re-rank and resize run once per NY session at cash close when `now`
 * is passed. A name held fewer than RISKOFF_ETF_MIN_HOLD_SESSIONS cash
 * sessions is not rotated off for RS. Omit `now` to score the rebalance
 * itself (unit tests).
 */
function heldCandidateNames(held?: string | string[] | null): RiskoffEtfCandidate[] {
  const raw = Array.isArray(held) ? held : held ? [held] : [];
  const out: RiskoffEtfCandidate[] = [];
  for (const h of raw) {
    const u = h.trim().toUpperCase();
    const hit = RISKOFF_ETF_CANDIDATES.find((s) => s === u);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

function pickAmongTiedBest(
  tied: RiskoffEtfCandidate[],
  held: readonly string[],
): RiskoffEtfSymbol {
  if (tied.length === 1) return tied[0];
  for (const h of held) {
    if (tied.includes(h as RiskoffEtfCandidate)) return h as RiskoffEtfCandidate;
  }
  for (const s of RISKOFF_ETF_CANDIDATES) {
    if (tied.includes(s)) return s;
  }
  return tied[0] ?? RISKOFF_ETF_CASH_SYMBOL;
}

function sortQualifiersByRs(
  names: RiskoffEtfCandidate[],
  returns: RiskoffEtfReturns,
): RiskoffEtfCandidate[] {
  return [...names].sort((a, b) => {
    const d = (returns[b] as number) - (returns[a] as number);
    if (d !== 0) return d > 0 ? 1 : -1;
    return RISKOFF_ETF_CANDIDATES.indexOf(a) - RISKOFF_ETF_CANDIDATES.indexOf(b);
  });
}

/**
 * Strict RISKOFF_ETF_CTA_CONFIRM_DAYS beat-BIL. Shared by the CTA gate, the
 * HYG-only gold gate, and the HYG-only equity-factor gate. A null map, or a
 * missing/non-finite own or BIL return, fails closed. Beat means strict
 * greater-than, same as 63d RS.
 */
export function riskoffEtfBeatsBil21d(
  symbol: string,
  returns21: RiskoffEtfReturns | null | undefined,
): boolean {
  if (!returns21) return false;
  const bil = returns21[RISKOFF_ETF_CASH_SYMBOL];
  const own = returns21[symbol.trim().toUpperCase() as RiskoffEtfSymbol];
  if (typeof bil !== "number" || !Number.isFinite(bil)) return false;
  if (typeof own !== "number" || !Number.isFinite(own)) return false;
  return own > bil;
}

/**
 * CTA-family 21d confirmation. Non-CTA names always pass. A null map, a
 * missing/non-finite BIL 21d return, or a missing/non-finite CTA 21d return
 * fails that CTA closed.
 */
export function riskoffEtfCtaConfirms21d(
  symbol: string,
  returns21: RiskoffEtfReturns | null | undefined,
): boolean {
  if (!isRiskoffEtfCta(symbol)) return true;
  return riskoffEtfBeatsBil21d(symbol, returns21);
}

/**
 * HYG-only RISK OFF: the book is RISK OFF, SPY is known above its 200dma,
 * and HYG is known below its 200dma. Missing spyAbove200 or hygAbove200 is
 * not this regime. SPY below 200 (puts can be on) is not this regime.
 */
export function riskoffHygOnlyRiskOff(
  riskOn: boolean,
  spyAbove200?: boolean | null,
  hygAbove200?: boolean | null,
): boolean {
  return riskOn === false && spyAbove200 === true && hygAbove200 === false;
}

/**
 * Gold-family 21d confirmation. Off unless the book is HYG-only RISK OFF.
 * When on, GLD and GDX must beat BIL on RISKOFF_ETF_CTA_CONFIRM_DAYS with
 * the same fail-closed missing-bar behavior as CTA. A 21d beat does not keep
 * GDX in the HYG-only RS basket (RISKOFF_ETF_HYG_ONLY_INELIGIBLE). GDX stays
 * in RISKOFF_ETF_GOLD_FAMILY. GLD is not in that drop. Non-gold names,
 * including PDBC, always pass. SPY below 200 does not require this check.
 */
export function riskoffEtfGoldConfirms21d(
  symbol: string,
  returns21: RiskoffEtfReturns | null | undefined,
  hygOnly: boolean,
): boolean {
  if (!hygOnly || !isRiskoffEtfGold(symbol)) return true;
  return riskoffEtfBeatsBil21d(symbol, returns21);
}

/**
 * HYG-only equity-factor 21d confirmation. Off unless the book is HYG-only
 * RISK OFF. When on, CLSE, USMV, QUAL, and FTLS must beat BIL on
 * RISKOFF_ETF_CTA_CONFIRM_DAYS with the same fail-closed missing-bar
 * behavior as CTA. Names outside RISKOFF_ETF_HYG_ONLY_21D_CONFIRM always
 * pass, including BTAL, XLP, and PDBC. SPY below 200 does not require this
 * check. Not a CTA or gold membership.
 */
export function riskoffEtfHygOnlyEquityConfirms21d(
  symbol: string,
  returns21: RiskoffEtfReturns | null | undefined,
  hygOnly: boolean,
): boolean {
  if (!hygOnly || !isRiskoffEtfHygOnly21dConfirm(symbol)) return true;
  return riskoffEtfBeatsBil21d(symbol, returns21);
}

/**
 * HYG-only RS eligibility. TLT, IEF, XLU, PDBC, KMLM, and GDX are not overlay
 * qualifiers in that regime, even if 63d beats BIL and own-200 is true.
 * KMLM stays ineligible there even when the always-on CTA 21d beat-BIL
 * confirm also passes. GDX (equity-levered gold / miners) stays ineligible
 * there even when the HYG-only gold 21d beat-BIL also passes. Off otherwise,
 * including when SPY is below 200.
 * The PDBC drop blocks a lone-PDBC full overlay and a PDBC+FTLS sleeve.
 * KMLM remains in RISKOFF_ETF_CTA_FAMILY for never-dual-CTA and that 21d
 * confirm when it is eligible. GDX remains in RISKOFF_ETF_GOLD_FAMILY for
 * never-dual-gold and for SPY-under-200 eligibility. GLD is not in this drop
 * and stays eligible with the HYG-only gold 21d beat-BIL. DBMF is unchanged.
 * Does not affect the gated duration book or RISKOFF_ETF_COMMODITY_BETA where
 * PDBC remains eligible.
 */
export function riskoffEtfHygOnlyRsEligible(symbol: string, hygOnly: boolean): boolean {
  if (!hygOnly) return true;
  return !isRiskoffEtfHygOnlyIneligible(symbol);
}

/**
 * Beat-BIL names; when above200 is passed, also require known-above-own-200.
 * When returns21 is passed (including null), CTA-family names must also beat
 * BIL on that 21d map. Omit returns21 to leave the CTA 21d gate off.
 * When hygOnly is true, gold-family names and RISKOFF_ETF_HYG_ONLY_21D_CONFIRM
 * names must beat BIL on that same map (a missing map fails them closed),
 * and RISKOFF_ETF_HYG_ONLY_INELIGIBLE names are dropped. Default false leaves
 * gold, the equity confirm set, and that drop off.
 */
export function riskoffEtfQualifiers(
  returns: RiskoffEtfReturns,
  above200?: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null,
  returns21?: RiskoffEtfReturns | null,
  hygOnly = false,
): RiskoffEtfCandidate[] {
  const bil = returns[RISKOFF_ETF_CASH_SYMBOL] as number;
  const beatBil = RISKOFF_ETF_CANDIDATES.filter((s) => (returns[s] as number) > bil);
  const trend =
    above200 === undefined || !RISKOFF_ETF_REQUIRE_ABOVE_200
      ? beatBil
      : beatBil.filter((s) => above200?.[s] === true);
  if (returns21 === undefined && !hygOnly) return trend;
  return trend.filter(
    (s) =>
      riskoffEtfHygOnlyRsEligible(s, hygOnly) &&
      (returns21 === undefined || riskoffEtfCtaConfirms21d(s, returns21)) &&
      riskoffEtfGoldConfirms21d(s, returns21, hygOnly) &&
      riskoffEtfHygOnlyEquityConfirms21d(s, returns21, hygOnly),
  );
}

function pickFromPool(
  pool: RiskoffEtfCandidate[],
  returns: RiskoffEtfReturns,
  held: readonly string[],
): RiskoffEtfCandidate | null {
  if (pool.length === 0) return null;
  let bestRet = -Infinity;
  for (const s of pool) {
    const r = returns[s] as number;
    if (r > bestRet) bestRet = r;
  }
  const protectedHeld = pool.filter((s) => {
    if (!held.includes(s)) return false;
    return bestRet - (returns[s] as number) < RISKOFF_ETF_RS_HYSTERESIS;
  });
  if (protectedHeld.length) return sortQualifiersByRs(protectedHeld, returns)[0] ?? null;
  const tied = pool.filter((s) => returns[s] === bestRet);
  const picked = pickAmongTiedBest(tied, held);
  return picked === RISKOFF_ETF_CASH_SYMBOL ? null : (picked as RiskoffEtfCandidate);
}

/**
 * Second sleeve name. Filters compose: CTA first, then gold, then the
 * PDBC↔CTA exclusion. When #1 is CTA, #2 comes from the non-CTA pool
 * (gold names may remain, so GDX can diversify a CTA #1 when GDX is still a
 * qualifier. HYG-only drops GDX via RISKOFF_ETF_HYG_ONLY_INELIGIBLE; gold-family
 * membership is unchanged. FLOT may fill that slot) and PDBC is dropped.
 * Empty pool after that → BIL, never the
 * other CTA and never PDBC. When #1 is gold, #2 comes from the non-gold
 * pool (CTAs may remain if they already cleared the 21d gate; PDBC and
 * FLOT may remain). Empty non-gold pool → BIL, never GLD+GDX. When #1 is
 * PDBC, #2 comes from the non-CTA pool (FLOT may fill it). Empty after
 * dropping CTAs → BIL, never PDBC+DBMF or PDBC+KMLM.
 * An empty remaining pool (no other qualifier at all) returns null so a
 * lone PDBC stays full size. A non-family #1 that is not PDBC uses the
 * ordinary remaining pool. Hysteresis still applies inside the filtered pool.
 */
export function pickRiskoffEtfSecond(
  remaining: RiskoffEtfCandidate[],
  first: RiskoffEtfCandidate,
  returns: RiskoffEtfReturns,
  held: readonly string[] = [],
): RiskoffEtfSymbol | null {
  let pool = remaining;
  if (isRiskoffEtfCta(first)) {
    pool = pool.filter((s) => !isRiskoffEtfCta(s));
    if (pool.length === 0) return RISKOFF_ETF_CASH_SYMBOL;
  }
  if (isRiskoffEtfGold(first)) {
    pool = pool.filter((s) => !isRiskoffEtfGold(s));
    if (pool.length === 0) return RISKOFF_ETF_CASH_SYMBOL;
  }
  if (isRiskoffEtfCta(first) || isRiskoffEtfCommodityBeta(first)) {
    const next = pool.filter((s) => !riskoffEtfPdbcCtaConflict(first, s));
    if (next.length === 0 && pool.length > 0) return RISKOFF_ETF_CASH_SYMBOL;
    pool = next;
  }
  if (pool.length === 0) return null;
  return pickFromPool(pool, returns, held);
}

export function pickRiskoffEtfSleeve(
  returns: RiskoffEtfReturns,
  held?: string | string[] | null,
  above200?: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null,
  returns21?: RiskoffEtfReturns | null,
  hygOnly = false,
): RiskoffEtfSymbol[] | null {
  if (!riskoffEtfReturnsReady(returns)) return null;
  const heldNames = heldCandidateNames(held);
  const qualifiers = riskoffEtfQualifiers(returns, above200, returns21, hygOnly);
  if (qualifiers.length === 0) return [RISKOFF_ETF_CASH_SYMBOL];
  const first = pickFromPool(qualifiers, returns, heldNames);
  if (!first) return [RISKOFF_ETF_CASH_SYMBOL];
  const remaining = qualifiers.filter((s) => s !== first);
  const second = pickRiskoffEtfSecond(
    remaining,
    first,
    returns,
    heldNames.filter((s) => s !== first),
  );
  if (!second) return [first];
  return [first, second];
}

export function pickRiskoffEtfWinner(
  returns: RiskoffEtfReturns,
  held?: string | null,
  above200?: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null,
  returns21?: RiskoffEtfReturns | null,
  hygOnly = false,
): RiskoffEtfSymbol | null {
  const sleeve = pickRiskoffEtfSleeve(returns, held, above200, returns21, hygOnly);
  return sleeve?.[0] ?? null;
}

export function sizeRiskoffEtfShares(
  last: number,
  equityUsd = DEFAULT_SLEEVE_EQUITY_USD,
  frac = RISKOFF_ETF_NOTIONAL_FRAC,
): number {
  if (!(last > 0) || !Number.isFinite(last) || !(equityUsd > 0) || !(frac > 0)) return 0;
  return Math.floor((equityUsd * frac) / last);
}

export function riskoffEtfNotionalUsd(
  last: number,
  qty: number,
): number {
  if (!(last > 0) || !(qty > 0)) return 0;
  return last * qty;
}

export function openRiskoffEtfPositions(positions: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of positions) {
    if (p.side === "Flat" || p.qty <= 0) continue;
    if (p.sleeveId !== "riskoff") continue;
    if (p.vertical || p.overlay) continue;
    if (p.gatedDuration) continue;
    if (!isRiskoffEtfSymbol(p.symbol)) continue;
    out.push(p);
  }
  return out;
}

function lastBySymbol(quotes: Array<{ symbol: string; last: number }>): Map<string, number> {
  const by = new Map<string, number>();
  for (const q of quotes) {
    const s = q.symbol.trim().toUpperCase();
    if (!s || !Number.isFinite(q.last) || !(q.last > 0)) continue;
    by.set(s, q.last);
  }
  return by;
}

function flattenOpen(
  open: Position[],
  reason: string,
  winners: RiskoffEtfSymbol[] | null,
): RiskoffEtfDecision {
  return {
    winner: winners?.[0] ?? null,
    winners: winners ?? [],
    reason,
    sells: open.map((p) => ({ sleeveId: "riskoff" as const, symbol: p.symbol, reason })),
    buy: null,
    buys: [],
  };
}

function overlayNamesFromOpen(open: Position[]): RiskoffEtfSymbol[] {
  const out: RiskoffEtfSymbol[] = [];
  for (const p of open) {
    if (!isRiskoffEtfSymbol(p.symbol)) continue;
    if (!out.includes(p.symbol)) out.push(p.symbol);
  }
  return out;
}

/** Hold open overlay lots. No sells, no new buys — last successful sleeve. */
function holdLastSleeve(open: Position[], reason: string): RiskoffEtfDecision {
  const winners = overlayNamesFromOpen(open);
  return {
    winner: winners[0] ?? null,
    winners,
    reason,
    sells: [],
    buy: null,
    buys: [],
  };
}

/**
 * Increment the missing-bars streak. Hold last sleeve until
 * RISKOFF_ETF_MISSING_BARS_MAX_MISSES consecutive misses, then flatten.
 */
function decideMissingBars(
  open: Position[],
  priorMisses: number,
): RiskoffEtfDecision {
  const misses = priorMisses + 1;
  missingBarsMisses = misses;
  if (misses < RISKOFF_ETF_MISSING_BARS_MAX_MISSES) {
    const held = overlayNamesFromOpen(open);
    if (held.length) priorOverlayTargets = held;
    return holdLastSleeve(
      open,
      `missing risk-off ETF bars: hold last sleeve (${misses}/${RISKOFF_ETF_MISSING_BARS_MAX_MISSES})`,
    );
  }
  const names = overlayNamesFromOpen(open);
  if (names.length) {
    priorOverlayTargets = names;
    pendingPriorRebuy = true;
  }
  return flattenOpen(open, "missing risk-off ETF bars", null);
}

function clearOverlayBookMemory(): void {
  pendingPriorRebuy = false;
  priorOverlayTargets = [];
  entrySessionBySymbol.clear();
}

function entryMapFromInput(
  entrySessions?: Partial<Record<string, string>> | null,
): Map<string, string> {
  const entries = new Map<string, string>();
  if (entrySessions) {
    for (const [k, v] of Object.entries(entrySessions)) {
      if (typeof v === "string" && v) entries.set(k.trim().toUpperCase(), v);
    }
    return entries;
  }
  for (const [k, v] of entrySessionBySymbol) entries.set(k, v);
  return entries;
}

function commitEntrySessions(
  entries: Map<string, string>,
  winners: RiskoffEtfSymbol[],
  asOf: string,
): void {
  for (const s of winners) {
    if (s === RISKOFF_ETF_CASH_SYMBOL) continue;
    if (!entries.has(s)) entries.set(s, asOf);
  }
  for (const s of [...entries.keys()]) {
    if (!winners.includes(s as RiskoffEtfSymbol)) entries.delete(s);
  }
  entrySessionBySymbol.clear();
  for (const [k, v] of entries) entrySessionBySymbol.set(k, v);
}

/**
 * Held candidates whose cash-session count is still inside the minimum
 * hold. A missing stamp is recorded as `asOf` (this rebalance), so a
 * restart does not immediately RS-rotate a name that is already on the book.
 * Caller drops names that no longer clear beat-BIL / own-200 / CTA 21d,
 * the HYG-only gold 21d check, the HYG-only equity 21d check, or the
 * HYG-only TLT/IEF/XLU/PDBC/KMLM/GDX drop. GDX stays in the gold family.
 * GLD is not in that drop. DBMF is not in that drop.
 */
function protectedOverlayNames(
  held: string[],
  asOf: string,
  entries: Map<string, string>,
): RiskoffEtfCandidate[] {
  const out: RiskoffEtfCandidate[] = [];
  for (const raw of held) {
    const symbol = raw.trim().toUpperCase();
    const hit = RISKOFF_ETF_CANDIDATES.find((s) => s === symbol);
    if (!hit) continue;
    if (!entries.has(hit)) entries.set(hit, asOf);
    const entry = entries.get(hit) as string;
    if (riskoffEtfSessionsHeld(entry, asOf) < RISKOFF_ETF_MIN_HOLD_SESSIONS && !out.includes(hit)) {
      out.push(hit);
    }
  }
  return out;
}

function sameFamilyPair(anchor: string, candidate: string): boolean {
  if (isRiskoffEtfCta(anchor) && isRiskoffEtfCta(candidate)) return true;
  if (isRiskoffEtfGold(anchor) && isRiskoffEtfGold(candidate)) return true;
  if (riskoffEtfPdbcCtaConflict(anchor, candidate)) return true;
  return false;
}

function anchorPairsWithBil(anchor: string): boolean {
  return isRiskoffEtfCta(anchor) || isRiskoffEtfGold(anchor);
}

function collapseDualFamily(
  kept: RiskoffEtfSymbol[],
  desired: RiskoffEtfSymbol[],
  isMember: (symbol: string) => boolean,
): RiskoffEtfSymbol[] {
  const members = kept.filter((s) => isMember(s));
  if (members.length < 2) return kept;
  const prefer = desired.find((d) => members.includes(d)) ?? members[0];
  return [prefer];
}

/**
 * PDBC #1 whose only other desired names are CTA (or BIL forced by that
 * exclusion) stays 50/50 with BIL. A lone PDBC with no other qualifier
 * does not.
 */
function pdbcAnchorNeedsBil(anchor: string, desired: RiskoffEtfSymbol[]): boolean {
  if (!isRiskoffEtfCommodityBeta(anchor)) return false;
  if (
    desired.includes(RISKOFF_ETF_CASH_SYMBOL) &&
    (desired[0] === anchor || riskoffEtfPdbcCtaConflict(desired[0] ?? "", anchor))
  ) {
    return true;
  }
  const others = desired.filter((d) => d !== anchor && d !== RISKOFF_ETF_CASH_SYMBOL);
  return others.length > 0 && others.every((d) => riskoffEtfPdbcCtaConflict(anchor, d));
}

/** Drop one side of a held PDBC+CTA pair. Prefer the RS sleeve's choice. */
function collapsePdbcCtaPair(
  kept: RiskoffEtfSymbol[],
  desired: RiskoffEtfSymbol[],
): RiskoffEtfSymbol[] {
  const pdbc = kept.find((s) => isRiskoffEtfCommodityBeta(s));
  const cta = kept.find((s) => isRiskoffEtfCta(s));
  if (!pdbc || !cta) return kept;
  const prefer = desired.find((d) => d === pdbc || d === cta) ?? pdbc;
  return [prefer];
}

/** Keep names still inside the minimum hold. Never leave two CTAs, two gold names, or PDBC with a CTA. */
function applyOverlayMinHold(
  desired: RiskoffEtfSymbol[],
  protectedNames: RiskoffEtfSymbol[],
): RiskoffEtfSymbol[] {
  if (protectedNames.length === 0) return desired;
  let kept = protectedNames.slice(0, RISKOFF_ETF_TOP_N);
  kept = collapseDualFamily(kept, desired, isRiskoffEtfCta);
  kept = collapseDualFamily(kept, desired, isRiskoffEtfGold);
  kept = collapsePdbcCtaPair(kept, desired);
  if (kept.length >= RISKOFF_ETF_TOP_N) return kept.slice(0, RISKOFF_ETF_TOP_N);
  const anchor = kept[0];
  const filler = desired.find((d) => d !== anchor && !sameFamilyPair(anchor, d));
  if (!filler || (filler === RISKOFF_ETF_CASH_SYMBOL && !anchorPairsWithBil(anchor))) {
    if (pdbcAnchorNeedsBil(anchor, desired)) return [anchor, RISKOFF_ETF_CASH_SYMBOL];
    return anchorPairsWithBil(anchor) ? [anchor, RISKOFF_ETF_CASH_SYMBOL] : [anchor];
  }
  return [anchor, filler];
}

function retainProtectedWinners(
  winners: RiskoffEtfSymbol[],
  protectedNames: RiskoffEtfSymbol[],
): RiskoffEtfSymbol[] {
  if (protectedNames.length === 0) return winners;
  const out = [...winners];
  for (const name of protectedNames) {
    if (out.includes(name)) continue;
    if (out.length < RISKOFF_ETF_TOP_N) {
      out.push(name);
      continue;
    }
    const replaceAt = out.findIndex((s) => !protectedNames.includes(s));
    if (replaceAt >= 0) out[replaceAt] = name;
  }
  const broken = breakPdbcCtaPair(
    breakDualFamily(breakDualFamily(out, protectedNames, isRiskoffEtfCta), protectedNames, isRiskoffEtfGold),
    protectedNames,
  );
  return broken.slice(0, RISKOFF_ETF_TOP_N);
}

/** Replace the other side of a PDBC+CTA pair with a non-conflicting name, else BIL. */
function breakPdbcCtaPair(
  out: RiskoffEtfSymbol[],
  protectedNames: RiskoffEtfSymbol[],
): RiskoffEtfSymbol[] {
  const pdbc = out.find((s) => isRiskoffEtfCommodityBeta(s));
  const cta = out.find((s) => isRiskoffEtfCta(s));
  if (!pdbc || !cta) return out.slice(0, RISKOFF_ETF_TOP_N);
  const keep = protectedNames.find((s) => s === pdbc || s === cta) ?? pdbc;
  const rest = out.filter((s) => s !== keep && !riskoffEtfPdbcCtaConflict(keep, s));
  return [keep, rest[0] ?? RISKOFF_ETF_CASH_SYMBOL];
}

function breakDualFamily(
  out: RiskoffEtfSymbol[],
  protectedNames: RiskoffEtfSymbol[],
  isMember: (symbol: string) => boolean,
): RiskoffEtfSymbol[] {
  const members = out.filter((s) => isMember(s));
  if (members.length < 2) return out.slice(0, RISKOFF_ETF_TOP_N);
  const keep = protectedNames.find((s) => members.includes(s)) ?? members[0];
  const rest = out.filter((s) => s !== keep && !isMember(s));
  return [keep, rest[0] ?? RISKOFF_ETF_CASH_SYMBOL];
}

function rebuyPriorOverlay(
  targets: RiskoffEtfSymbol[],
  quotes: Map<string, number>,
  spyAbove200?: boolean | null,
): RiskoffEtfDecision {
  const names = targets.filter((s) => isRiskoffEtfSymbol(s));
  const totalFrac = riskoffEtfNotionalFrac(spyAbove200);
  const frac = riskoffEtfSleeveFrac(names.length, totalFrac);
  const buys: RiskoffEtfBuy[] = [];
  for (const name of names) {
    const last = quotes.get(name);
    if (last === undefined) continue;
    const qty = sizeRiskoffEtfShares(last, DEFAULT_SLEEVE_EQUITY_USD, frac);
    if (qty < 1) continue;
    const thesis = overlayThesis(names, null);
    buys.push({
      sleeveId: "riskoff",
      symbol: name,
      side: "Buy",
      qty,
      stopPrice: last * RISKOFF_ETF_STOP_MUL,
      thesis: names.length >= 2 ? `${thesis} ${name}` : thesis,
    });
  }
  if (buys.length === 0) {
    return {
      winner: names[0] ?? null,
      winners: names,
      reason: "prior overlay unquoted: cash",
      sells: [],
      buy: null,
      buys: [],
    };
  }
  const winners = buys.map((b) => b.symbol);
  return {
    winner: winners[0] ?? null,
    winners,
    reason: "rebuy prior overlay until NY cash close",
    sells: [],
    buy: buys[0] ?? null,
    buys,
  };
}

/** Midday (and post-rebalance) path: no RS rotate, no resize. Prior targets may be rebought. */
function decideIntradayOverlay(input: {
  now: Date;
  open: Position[];
  quotes: Map<string, number>;
  spyAbove200?: boolean | null;
}): RiskoffEtfDecision {
  const ymd = riskoffEtfNyYmd(input.now);
  if (input.open.length > 0) {
    const names = overlayNamesFromOpen(input.open);
    if (names.length) priorOverlayTargets = names;
    const reason =
      lastRebalanceYmd === ymd
        ? "hold overlay: rebalanced this NY session"
        : "hold overlay until NY cash close";
    return holdLastSleeve(input.open, reason);
  }
  if (pendingPriorRebuy && priorOverlayTargets.length > 0) {
    return rebuyPriorOverlay(priorOverlayTargets, input.quotes, input.spyAbove200);
  }
  return {
    winner: null,
    winners: [],
    reason: "overlay rebalance waits for NY cash close",
    sells: [],
    buy: null,
    buys: [],
  };
}

function overlayThesis(
  names: RiskoffEtfSymbol[],
  trendPark: string | null,
): string {
  if (trendPark) return trendPark;
  if (names.length >= 2) {
    return `auto risk-off ETF RS ${RISKOFF_ETF_LOOKBACK_DAYS}d top-2 ${names.join("+")} 50/50`;
  }
  return `auto risk-off ETF RS ${RISKOFF_ETF_LOOKBACK_DAYS}d winner ${names[0]}`;
}

/**
 * Paper risk-off sleeve loss cap. Trips when realized P/L, or the blotter
 * sleeve book's daily P/L, or its total P/L, is at or below −lossCapUsd.
 * Daily and total are sleeveBooks.riskoff.dailyPnlUsd / totalPnlUsd (the
 * sleeve-tab d / tot on GET /api/status). Omit the book and only realized
 * is checked.
 */
export function riskoffSleeveLossCapHit(
  sleeve: SleeveCard,
  book?: { dailyPnlUsd?: number | null; totalPnlUsd?: number | null } | null,
): boolean {
  const floor = -sleeve.lossCapUsd;
  if (sleeve.paper.realizedPnlUsd <= floor) return true;
  const daily = book?.dailyPnlUsd;
  const total = book?.totalPnlUsd;
  if (typeof daily === "number" && daily <= floor) return true;
  if (typeof total === "number" && total <= floor) return true;
  return false;
}

export function decideRiskoffEtf(input: {
  riskOn: boolean;
  positions: Position[];
  sleeve: SleeveCard;
  returns: RiskoffEtfReturns | null;
  quotes: Array<{ symbol: string; last: number }>;
  /** Own-200 map from the same Massive dailies as `returns`. Missing 200 → not a qualifier. */
  above200?: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null;
  /**
   * RISKOFF_ETF_CTA_CONFIRM_DAYS total returns from the same dailies.
   * Omit or null → every CTA fails closed. In HYG-only RISK OFF the same
   * map fails gold-family names and RISKOFF_ETF_HYG_ONLY_21D_CONFIRM closed.
   * PDBC, FLOT, XLP, and BTAL are unchanged. A missing 21d return skips that
   * name only; it is not a 63d missing-bars miss.
   */
  returns21?: RiskoffEtfReturns | null;
  /**
   * Same spyAbove200 as the put gate (riskoffEquityPutsAllowed). True → 60%
   * overlay (puts gated). False/missing → 40%. Does not change RISK ON flatten.
   * With hygAbove200 === false and risk off, also turns on the gold 21d gate,
   * the equity-factor 21d gate, and the TLT/IEF/XLU/PDBC/KMLM/GDX RS drop.
   * KMLM stays in the CTA family. GDX stays in the gold family. GLD is not
   * in that drop. DBMF is not in that drop.
   */
  spyAbove200?: boolean | null;
  /**
   * HYG 200dma from the risk badge. HYG-only RISK OFF is risk off, this
   * false, and spyAbove200 true. Missing is not HYG-only (gold 21d, equity
   * 21d, and the TLT/IEF/XLU/PDBC/KMLM/GDX RS drop stay off). GDX stays in
   * the gold family. DBMF stays eligible.
   */
  hygAbove200?: boolean | null;
  /**
   * Consecutive missing-bars misses already counted before this decision.
   * Omit to use the process-local streak (autopilot ticks). Tests pass this
   * to isolate a single call. A successful RS path resets the streak to 0.
   */
  missingBarsMisses?: number;
  /**
   * Valuation clock. When set, RS re-rank and notional resize run only once
   * per NY session at/after the cash close (16:00 ET, 13:00 on early-close
   * days). Midday calls hold the open sleeve. After a missing-bars flatten,
   * bars that return before that close rebuy the prior targets. Omit to
   * apply the rebalance decision immediately (RS unit tests). Autopilot
   * passes this from the paper clock.
   */
  now?: Date | null;
  /**
   * NY session date (YYYY-MM-DD) each overlay name was entered. Used with
   * `now` for the 5-session minimum hold. Omit to use process memory.
   * A held name with no stamp is treated as entered on this rebalance.
   */
  entrySessions?: Partial<Record<string, string>> | null;
  /**
   * Blotter sleeve book (sleeveBooks.riskoff). dailyPnlUsd or totalPnlUsd
   * at or below −lossCapUsd flattens the overlay the same way realized does.
   * Omit and only realized P/L is checked.
   */
  sleeveBook?: { dailyPnlUsd?: number | null; totalPnlUsd?: number | null } | null;
}): RiskoffEtfDecision {
  const open = openRiskoffEtfPositions(input.positions);
  const priorMisses = input.missingBarsMisses ?? missingBarsMisses;

  if (input.riskOn) {
    missingBarsMisses = 0;
    clearOverlayBookMemory();
    return flattenOpen(open, "risk on: flatten risk-off ETF", null);
  }
  if (riskoffSleeveLossCapHit(input.sleeve, input.sleeveBook)) {
    missingBarsMisses = 0;
    clearOverlayBookMemory();
    return flattenOpen(open, "sleeve loss cap", null);
  }
  if (!input.returns) {
    return decideMissingBars(open, priorMisses);
  }

  const heldNames = open.map((p) => p.symbol);
  const above200 = input.above200 ?? emptyRiskoffEtfAbove200();
  const returns21 = input.returns21 ?? emptyRiskoffEtfReturns();
  const hygOnly = riskoffHygOnlyRiskOff(input.riskOn, input.spyAbove200, input.hygAbove200);
  const rsSleeve = pickRiskoffEtfSleeve(input.returns, heldNames, undefined, returns21, hygOnly);
  let sleeve = pickRiskoffEtfSleeve(input.returns, heldNames, above200, returns21, hygOnly);
  if (sleeve === null || rsSleeve === null) {
    return decideMissingBars(open, priorMisses);
  }
  missingBarsMisses = 0;

  const quotes = lastBySymbol(input.quotes);
  if (input.now && !riskoffEtfRebalanceDue(input.now, lastRebalanceYmd)) {
    return decideIntradayOverlay({
      now: input.now,
      open,
      quotes,
      spyAbove200: input.spyAbove200,
    });
  }

  const asOf = input.now ? riskoffEtfNyYmd(input.now) : null;
  let entries: Map<string, string> | null = null;
  let protectedNames: RiskoffEtfSymbol[] = [];
  if (input.now && asOf) {
    entries = entryMapFromInput(input.entrySessions);
    const stillQualified = new Set(riskoffEtfQualifiers(input.returns, above200, returns21, hygOnly));
    protectedNames = protectedOverlayNames(heldNames, asOf, entries).filter((name) =>
      stillQualified.has(name),
    );
    sleeve = applyOverlayMinHold(sleeve, protectedNames);
    lastRebalanceYmd = asOf;
    pendingPriorRebuy = false;
  }
  const finish = (decision: RiskoffEtfDecision): RiskoffEtfDecision => {
    if (entries && asOf) commitEntrySessions(entries, decision.winners, asOf);
    if (decision.winners.length) priorOverlayTargets = [...decision.winners];
    return decision;
  };
  const totalFrac = riskoffEtfNotionalFrac(input.spyAbove200);
  const canSize = (name: RiskoffEtfSymbol, frac: number): boolean => {
    const last = quotes.get(name);
    if (last === undefined) return false;
    return sizeRiskoffEtfShares(last, DEFAULT_SLEEVE_EQUITY_USD, frac) >= 1;
  };
  const halfFrac = riskoffEtfSleeveFrac(RISKOFF_ETF_TOP_N, totalFrac);
  const canHalf = sleeve.filter((s) => canSize(s, halfFrac));
  const canFull = sleeve.filter((s) => canSize(s, totalFrac));
  const tradable = canHalf.length >= RISKOFF_ETF_TOP_N ? canHalf.slice(0, RISKOFF_ETF_TOP_N) : canFull.slice(0, 1);

  const trendPark =
    sleeve.length === 1 &&
    sleeve[0] === RISKOFF_ETF_CASH_SYMBOL &&
    rsSleeve[0] !== RISKOFF_ETF_CASH_SYMBOL
      ? absoluteTrendParkReason(rsSleeve[0], above200)
      : null;

  if (tradable.length === 0) {
    const head = sleeve[0];
    const reason =
      trendPark ??
      (head === RISKOFF_ETF_CASH_SYMBOL ? "BIL unquoted: cash" : `${head} unquoted: cash`);
    return finish(flattenOpen(open, reason, sleeve));
  }

  let winners = tradable.slice(0, RISKOFF_ETF_TOP_N);
  if (protectedNames.length) winners = retainProtectedWinners(winners, protectedNames);
  const winner = winners[0];
  const frac = riskoffEtfSleeveFrac(winners.length, totalFrac);
  const want = new Set(winners.map((s) => s.toUpperCase()));
  const extras = open.filter((p) => !want.has(p.symbol.toUpperCase()));
  const label = winners.join("+");
  const pct = Math.round(totalFrac * 100);
  const sells: RiskoffEtfSell[] = extras.map((p) => ({
    sleeveId: "riskoff",
    symbol: p.symbol,
    reason: `rotate to ${label}`,
  }));

  const heldWanted = open.filter((p) => want.has(p.symbol.toUpperCase()) && p.qty > 0);
  const heldBy = new Map(heldWanted.map((p) => [p.symbol.toUpperCase(), p]));
  const toBuy: RiskoffEtfSymbol[] = [];
  let resized = false;
  for (const name of winners) {
    const last = quotes.get(name);
    if (last === undefined) continue;
    const targetQty = sizeRiskoffEtfShares(last, DEFAULT_SLEEVE_EQUITY_USD, frac);
    if (targetQty < 1) continue;
    const held = heldBy.get(name);
    if (!held) {
      toBuy.push(name);
      continue;
    }
    if (overlayLotNeedsResize(held.qty, targetQty, last)) {
      sells.push({
        sleeveId: "riskoff",
        symbol: held.symbol,
        reason: `resize overlay to ${pct}%`,
      });
      toBuy.push(name);
      resized = true;
    }
  }

  if (toBuy.length === 0) {
    return finish({
      winner,
      winners,
      reason: `hold ${label}`,
      sells,
      buy: null,
      buys: [],
    });
  }

  const buys: RiskoffEtfBuy[] = [];
  for (const name of toBuy) {
    const last = quotes.get(name);
    if (last === undefined) continue;
    const qty = sizeRiskoffEtfShares(last, DEFAULT_SLEEVE_EQUITY_USD, frac);
    if (qty < 1) continue;
    const thesis = overlayThesis(winners, trendPark);
    buys.push({
      sleeveId: "riskoff",
      symbol: name,
      side: "Buy",
      qty,
      stopPrice: last * RISKOFF_ETF_STOP_MUL,
      thesis: winners.length >= 2 ? `${thesis} ${name}` : thesis,
    });
  }

  if (buys.length === 0) {
    const reason = trendPark ?? "size rounds to 0: cash";
    return finish(flattenOpen(open, reason, winners));
  }

  return finish({
    winner,
    winners,
    reason: trendPark ?? (resized ? `resize overlay to ${pct}%` : `buy ${label}`),
    sells,
    buy: buys[0] ?? null,
    buys,
  });
}

async function fetchRiskoffEtfBars(): Promise<Partial<
  Record<RiskoffEtfSymbol, DailyBar[] | null | undefined>
> | null> {
  const pairs = await Promise.all(
    RISKOFF_ETF_SYMBOLS.map(async (symbol) => {
      const bars = await fetchMassiveDailyBars(symbol);
      return [symbol, bars] as const;
    }),
  );
  if (pairs.every(([, bars]) => !bars)) return null;
  const bars: Partial<Record<RiskoffEtfSymbol, DailyBar[] | null | undefined>> = {};
  for (const [symbol, series] of pairs) bars[symbol] = series;
  return bars;
}

/** Same Massive dailies for 63d returns, the shared 21d beat-BIL window, and each name's 200dma. One fetch. */
export async function fetchRiskoffEtfOverlay(): Promise<RiskoffEtfOverlaySnapshot | null> {
  const bars = await fetchRiskoffEtfBars();
  if (!bars) return null;
  return {
    returns: riskoffEtfReturnsFromBars(bars),
    returns21: riskoffEtfReturnsFromBars(bars, RISKOFF_ETF_CTA_CONFIRM_DAYS),
    above200: riskoffEtfAbove200FromBars(bars),
  };
}

export async function fetchRiskoffEtfReturns(): Promise<RiskoffEtfReturns | null> {
  const snap = await fetchRiskoffEtfOverlay();
  return snap?.returns ?? null;
}
