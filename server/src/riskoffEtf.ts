import {
  DEFAULT_SLEEVE_EQUITY_USD,
  RISKOFF_ETF_CANDIDATES,
  RISKOFF_ETF_CASH_SYMBOL,
  RISKOFF_ETF_LOOKBACK_DAYS,
  RISKOFF_ETF_NOTIONAL_FRAC,
  RISKOFF_ETF_REQUIRE_ABOVE_200,
  RISKOFF_ETF_RS_HYSTERESIS,
  RISKOFF_ETF_STOP_MUL,
  RISKOFF_ETF_SYMBOLS,
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

export type RiskoffEtfDecision = {
  winner: RiskoffEtfSymbol | null;
  reason: string;
  sells: RiskoffEtfSell[];
  buy: RiskoffEtfBuy | null;
};

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
 * its own 200dma. BIL is never 200-filtered. Not a re-rank.
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
 * BIL, pick the highest 63d return. If held is still eligible, keep it unless
 * a challenger leads by RISKOFF_ETF_RS_HYSTERESIS or more. Exact RS tie keeps
 * the held name when it is still eligible, else preference order
 * GLD > UUP > TLT > IEF > XLU > XLP > DBMF. Hysteresis does not apply when
 * held is missing, not an overlay candidate, or ineligible (return ≤ BIL).
 * After that RS pick, RISKOFF_ETF_REQUIRE_ABOVE_200 parks a candidate in BIL
 * unless that name is known above its own 200dma (above200 === true). Missing
 * or at/below 200 → BIL; do not fall through to the next RS name. BIL itself
 * is never 200-filtered. Pass above200 to apply the filter; omit it to test
 * RS/hysteresis in isolation. Absolute trend overrides a hysteresis hold.
 */
function pickAmongTiedBest(
  tied: Array<(typeof RISKOFF_ETF_CANDIDATES)[number]>,
  heldU: string,
): RiskoffEtfSymbol {
  if (tied.length === 1) return tied[0];
  if (isRiskoffEtfSymbol(heldU) && tied.includes(heldU as (typeof RISKOFF_ETF_CANDIDATES)[number])) {
    return heldU;
  }
  for (const s of RISKOFF_ETF_CANDIDATES) {
    if (tied.includes(s)) return s;
  }
  return tied[0] ?? RISKOFF_ETF_CASH_SYMBOL;
}

export function pickRiskoffEtfWinner(
  returns: RiskoffEtfReturns,
  held?: string | null,
  above200?: Partial<Record<RiskoffEtfSymbol, boolean | null>> | null,
): RiskoffEtfSymbol | null {
  if (!riskoffEtfReturnsReady(returns)) return null;
  const bil = returns[RISKOFF_ETF_CASH_SYMBOL] as number;
  const heldU = held?.trim().toUpperCase() ?? "";
  const eligible = RISKOFF_ETF_CANDIDATES.filter((s) => (returns[s] as number) > bil);
  if (eligible.length === 0) {
    return applyRiskoffEtfAbsoluteTrend(RISKOFF_ETF_CASH_SYMBOL, above200);
  }

  let bestRet = -Infinity;
  for (const s of eligible) {
    const r = returns[s] as number;
    if (r > bestRet) bestRet = r;
  }

  const heldCandidate = RISKOFF_ETF_CANDIDATES.find((s) => s === heldU);
  if (heldCandidate && eligible.includes(heldCandidate)) {
    const heldReturn = returns[heldCandidate] as number;
    if (bestRet - heldReturn < RISKOFF_ETF_RS_HYSTERESIS) {
      if (above200 === undefined) return heldCandidate;
      return applyRiskoffEtfAbsoluteTrend(heldCandidate, above200);
    }
  }

  const tied = eligible.filter((s) => returns[s] === bestRet);
  const rsWinner = pickAmongTiedBest(tied, heldU);
  if (above200 === undefined) return rsWinner;
  return applyRiskoffEtfAbsoluteTrend(rsWinner, above200);
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

function flattenOpen(open: Position[], reason: string, winner: RiskoffEtfSymbol | null): RiskoffEtfDecision {
  return {
    winner,
    reason,
    sells: open.map((p) => ({ sleeveId: "riskoff" as const, symbol: p.symbol, reason })),
    buy: null,
  };
}

export function decideRiskoffEtf(input: {
  riskOn: boolean;
  positions: Position[];
  sleeve: SleeveCard;
  returns: RiskoffEtfReturns | null;
  quotes: Array<{ symbol: string; last: number }>;
  /** Own-200 map from the same Massive dailies as `returns`. Missing winner → BIL. */
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

  const held = open.length === 1 ? open[0].symbol : null;
  const above200 = input.above200 ?? emptyRiskoffEtfAbove200();
  const rsWinner = pickRiskoffEtfWinner(input.returns, held);
  const winner = pickRiskoffEtfWinner(input.returns, held, above200);
  if (winner === null || rsWinner === null) {
    return flattenOpen(open, "missing risk-off ETF bars", null);
  }

  const trendPark =
    winner === RISKOFF_ETF_CASH_SYMBOL &&
    rsWinner !== RISKOFF_ETF_CASH_SYMBOL
      ? absoluteTrendParkReason(rsWinner, above200)
      : null;

  const extras = open.filter((p) => p.symbol.toUpperCase() !== winner);
  const heldWinner = open.find((p) => p.symbol.toUpperCase() === winner);
  const sells: RiskoffEtfSell[] = extras.map((p) => ({
    sleeveId: "riskoff",
    symbol: p.symbol,
    reason: `rotate to ${winner}`,
  }));

  if (heldWinner && heldWinner.qty > 0) {
    return { winner, reason: `hold ${winner}`, sells, buy: null };
  }

  const last = lastBySymbol(input.quotes).get(winner);
  if (last === undefined) {
    const reason =
      trendPark ??
      (winner === RISKOFF_ETF_CASH_SYMBOL ? "BIL unquoted: cash" : `${winner} unquoted: cash`);
    return flattenOpen(open, reason, winner);
  }

  const qty = sizeRiskoffEtfShares(last);
  if (qty < 1) {
    return flattenOpen(open, "size rounds to 0: cash", winner);
  }

  return {
    winner,
    reason: trendPark ?? `buy ${winner}`,
    sells,
    buy: {
      sleeveId: "riskoff",
      symbol: winner,
      side: "Buy",
      qty,
      stopPrice: last * RISKOFF_ETF_STOP_MUL,
      thesis: trendPark ?? `auto risk-off ETF RS ${RISKOFF_ETF_LOOKBACK_DAYS}d winner ${winner}`,
    },
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
