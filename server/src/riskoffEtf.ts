import {
  DEFAULT_SLEEVE_EQUITY_USD,
  RISKOFF_ETF_CANDIDATES,
  RISKOFF_ETF_CASH_SYMBOL,
  RISKOFF_ETF_CTA_FAMILY,
  RISKOFF_ETF_LOOKBACK_DAYS,
  RISKOFF_ETF_NOTIONAL_FRAC,
  RISKOFF_ETF_REQUIRE_ABOVE_200,
  RISKOFF_ETF_RS_HYSTERESIS,
  RISKOFF_ETF_STOP_MUL,
  RISKOFF_ETF_SYMBOLS,
  RISKOFF_ETF_TOP_N,
  type RiskoffEtfSymbol,
} from "../../shared/constants";
import type { Position, SleeveCard } from "../../shared/types";
import { fetchMassiveDailyBars, type DailyBar } from "./massive";

export type RiskoffEtfReturns = Record<RiskoffEtfSymbol, number | null>;
/** Own-200 vs last close. Null = short/missing series (fail closed). BIL is unused. */
export type RiskoffEtfAbove200 = Record<RiskoffEtfSymbol, boolean | null>;

export type RiskoffEtfOverlaySnapshot = {
  returns: RiskoffEtfReturns;
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

export function isRiskoffEtfCta(symbol: string): boolean {
  return (RISKOFF_ETF_CTA_FAMILY as readonly string[]).includes(symbol.trim().toUpperCase());
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

export function riskoffEtfReturnFromBars(bars: DailyBar[] | null | undefined): number | null {
  return periodReturn(closesFromBars(bars), RISKOFF_ETF_LOOKBACK_DAYS);
}

export function riskoffEtfReturnsFromBars(
  bars: Partial<Record<RiskoffEtfSymbol, DailyBar[] | null | undefined>>,
): RiskoffEtfReturns {
  const out = emptyRiskoffEtfReturns();
  for (const s of RISKOFF_ETF_SYMBOLS) {
    out[s] = riskoffEtfReturnFromBars(bars[s]);
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

export function riskoffEtfSleeveFrac(nameCount: number): number {
  if (nameCount >= RISKOFF_ETF_TOP_N) return RISKOFF_ETF_NOTIONAL_FRAC / RISKOFF_ETF_TOP_N;
  return RISKOFF_ETF_NOTIONAL_FRAC;
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
 * Any missing overlay-universe return → null (cash). Among names that beat
 * BIL, pick the highest 63d return. If a held name is still eligible, keep it
 * unless a challenger leads by RISKOFF_ETF_RS_HYSTERESIS or more. Exact RS
 * tie keeps a held name when it is still eligible, else preference order
 * GLD > UUP > TLT > IEF > XLU > XLP > DBMF > KMLM. Hysteresis does not apply
 * when held is missing, not an overlay candidate, or ineligible (return ≤ BIL).
 * Pass above200 to treat own-200 as a qualifier filter (beat BIL and above
 * 200); omit it to test RS/hysteresis in isolation. Names that fail 200 are
 * skipped; if none qualify → BIL. BIL itself is never 200-filtered.
 * While RISK OFF, pickRiskoffEtfSleeve then takes the top-2 qualifiers at
 * 50/50 overlay notional (one name at full size; none → BIL). When #1 is in
 * RISKOFF_ETF_CTA_FAMILY, #2 prefers a non-CTA qualifier.
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

/** Beat-BIL names; when above200 is passed, also require known-above-own-200. */
export function riskoffEtfQualifiers(
  returns: RiskoffEtfReturns,
  above200?: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null,
): RiskoffEtfCandidate[] {
  const bil = returns[RISKOFF_ETF_CASH_SYMBOL] as number;
  const beatBil = RISKOFF_ETF_CANDIDATES.filter((s) => (returns[s] as number) > bil);
  if (above200 === undefined || !RISKOFF_ETF_REQUIRE_ABOVE_200) return beatBil;
  return beatBil.filter((s) => above200?.[s] === true);
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
 * Second sleeve name: highest remaining qualifier, except when #1 is CTA —
 * then prefer the highest-ranked non-CTA qualifier, and only pair two CTAs
 * if no non-CTA qualifier exists. Hysteresis still applies inside that pool.
 */
export function pickRiskoffEtfSecond(
  remaining: RiskoffEtfCandidate[],
  first: RiskoffEtfCandidate,
  returns: RiskoffEtfReturns,
  held: readonly string[] = [],
): RiskoffEtfCandidate | null {
  if (remaining.length === 0) return null;
  const pool =
    isRiskoffEtfCta(first) && remaining.some((s) => !isRiskoffEtfCta(s))
      ? remaining.filter((s) => !isRiskoffEtfCta(s))
      : remaining;
  return pickFromPool(pool, returns, held);
}

export function pickRiskoffEtfSleeve(
  returns: RiskoffEtfReturns,
  held?: string | string[] | null,
  above200?: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null,
): RiskoffEtfSymbol[] | null {
  if (!riskoffEtfReturnsReady(returns)) return null;
  const heldNames = heldCandidateNames(held);
  const qualifiers = riskoffEtfQualifiers(returns, above200);
  if (qualifiers.length === 0) return [RISKOFF_ETF_CASH_SYMBOL];
  const first = pickFromPool(qualifiers, returns, heldNames);
  if (!first) return [RISKOFF_ETF_CASH_SYMBOL];
  if (qualifiers.length === 1) return [first];
  const remaining = qualifiers.filter((s) => s !== first);
  const second = pickRiskoffEtfSecond(remaining, first, returns, heldNames.filter((s) => s !== first));
  if (!second) return [first];
  return [first, second];
}

export function pickRiskoffEtfWinner(
  returns: RiskoffEtfReturns,
  held?: string | null,
  above200?: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null,
): RiskoffEtfSymbol | null {
  const sleeve = pickRiskoffEtfSleeve(returns, held, above200);
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

export function decideRiskoffEtf(input: {
  riskOn: boolean;
  positions: Position[];
  sleeve: SleeveCard;
  returns: RiskoffEtfReturns | null;
  quotes: Array<{ symbol: string; last: number }>;
  /** Own-200 map from the same Massive dailies as `returns`. Missing 200 → not a qualifier. */
  above200?: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null;
}): RiskoffEtfDecision {
  const open = openRiskoffEtfPositions(input.positions);

  if (input.riskOn) {
    return flattenOpen(open, "risk on: flatten risk-off ETF", null);
  }
  if (input.sleeve.paper.realizedPnlUsd <= -input.sleeve.lossCapUsd) {
    return flattenOpen(open, "sleeve loss cap", null);
  }
  if (!input.returns) {
    return flattenOpen(open, "missing risk-off ETF bars", null);
  }

  const heldNames = open.map((p) => p.symbol);
  const above200 = input.above200 ?? emptyRiskoffEtfAbove200();
  const rsSleeve = pickRiskoffEtfSleeve(input.returns, heldNames);
  const sleeve = pickRiskoffEtfSleeve(input.returns, heldNames, above200);
  if (sleeve === null || rsSleeve === null) {
    return flattenOpen(open, "missing risk-off ETF bars", null);
  }

  const quotes = lastBySymbol(input.quotes);
  const canSize = (name: RiskoffEtfSymbol, frac: number): boolean => {
    const last = quotes.get(name);
    if (last === undefined) return false;
    return sizeRiskoffEtfShares(last, DEFAULT_SLEEVE_EQUITY_USD, frac) >= 1;
  };
  const halfFrac = riskoffEtfSleeveFrac(RISKOFF_ETF_TOP_N);
  const canHalf = sleeve.filter((s) => canSize(s, halfFrac));
  const canFull = sleeve.filter((s) => canSize(s, RISKOFF_ETF_NOTIONAL_FRAC));
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
    return flattenOpen(open, reason, sleeve);
  }

  const winners = tradable.slice(0, RISKOFF_ETF_TOP_N);
  const winner = winners[0];
  const frac = riskoffEtfSleeveFrac(winners.length);
  const want = new Set(winners.map((s) => s.toUpperCase()));
  const extras = open.filter((p) => !want.has(p.symbol.toUpperCase()));
  const label = winners.join("+");
  const sells: RiskoffEtfSell[] = extras.map((p) => ({
    sleeveId: "riskoff",
    symbol: p.symbol,
    reason: `rotate to ${label}`,
  }));

  const heldWanted = open.filter((p) => want.has(p.symbol.toUpperCase()) && p.qty > 0);
  const missing = winners.filter(
    (s) => !heldWanted.some((p) => p.symbol.toUpperCase() === s),
  );

  if (missing.length === 0) {
    return {
      winner,
      winners,
      reason: `hold ${label}`,
      sells,
      buy: null,
      buys: [],
    };
  }

  const buys: RiskoffEtfBuy[] = [];
  for (const name of missing) {
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
    return flattenOpen(open, reason, winners);
  }

  return {
    winner,
    winners,
    reason: trendPark ?? `buy ${label}`,
    sells,
    buy: buys[0] ?? null,
    buys,
  };
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

/** Same Massive dailies for 63d returns and each name's 200dma. One fetch. */
export async function fetchRiskoffEtfOverlay(): Promise<RiskoffEtfOverlaySnapshot | null> {
  const bars = await fetchRiskoffEtfBars();
  if (!bars) return null;
  return {
    returns: riskoffEtfReturnsFromBars(bars),
    above200: riskoffEtfAbove200FromBars(bars),
  };
}

export async function fetchRiskoffEtfReturns(): Promise<RiskoffEtfReturns | null> {
  const snap = await fetchRiskoffEtfOverlay();
  return snap?.returns ?? null;
}
