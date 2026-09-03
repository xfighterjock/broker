import {
  DEFAULT_SLEEVE_EQUITY_USD,
  RISKOFF_ETF_CANDIDATES,
  RISKOFF_ETF_CASH_SYMBOL,
  RISKOFF_ETF_LOOKBACK_DAYS,
  RISKOFF_ETF_NOTIONAL_FRAC,
  RISKOFF_ETF_STOP_MUL,
  RISKOFF_ETF_SYMBOLS,
  type RiskoffEtfSymbol,
} from "../../shared/constants";
import type { Position, SleeveCard } from "../../shared/types";
import { fetchMassiveDailyBars, type DailyBar } from "./massive";

export type RiskoffEtfReturns = Record<RiskoffEtfSymbol, number | null>;

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
 * BIL, pick the highest 63d return. Exact RS tie keeps the held name when it
 * is still eligible, else preference order GLD > UUP > TLT > IEF > XLU > XLP > DBMF.
 */
export function pickRiskoffEtfWinner(
  returns: RiskoffEtfReturns,
  held?: string | null,
): RiskoffEtfSymbol | null {
  if (!riskoffEtfReturnsReady(returns)) return null;
  const bil = returns[RISKOFF_ETF_CASH_SYMBOL] as number;
  const heldU = held?.trim().toUpperCase() ?? "";
  const eligible = RISKOFF_ETF_CANDIDATES.filter((s) => (returns[s] as number) > bil);
  if (eligible.length === 0) return RISKOFF_ETF_CASH_SYMBOL;

  let bestRet = -Infinity;
  for (const s of eligible) {
    const r = returns[s] as number;
    if (r > bestRet) bestRet = r;
  }
  const tied = eligible.filter((s) => returns[s] === bestRet);
  if (tied.length === 1) return tied[0];
  if (isRiskoffEtfSymbol(heldU) && tied.includes(heldU as (typeof RISKOFF_ETF_CANDIDATES)[number])) {
    return heldU;
  }
  for (const s of RISKOFF_ETF_CANDIDATES) {
    if (tied.includes(s)) return s;
  }
  return tied[0] ?? RISKOFF_ETF_CASH_SYMBOL;
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
  const winner = pickRiskoffEtfWinner(input.returns, held);
  if (winner === null) {
    return flattenOpen(open, "missing risk-off ETF bars", null);
  }

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
      winner === RISKOFF_ETF_CASH_SYMBOL ? "BIL unquoted: cash" : `${winner} unquoted: cash`;
    return flattenOpen(open, reason, winner);
  }

  const qty = sizeRiskoffEtfShares(last);
  if (qty < 1) {
    return flattenOpen(open, "size rounds to 0: cash", winner);
  }

  return {
    winner,
    reason: `buy ${winner}`,
    sells,
    buy: {
      sleeveId: "riskoff",
      symbol: winner,
      side: "Buy",
      qty,
      stopPrice: last * RISKOFF_ETF_STOP_MUL,
      thesis: `auto risk-off ETF RS ${RISKOFF_ETF_LOOKBACK_DAYS}d winner ${winner}`,
    },
  };
}

export async function fetchRiskoffEtfReturns(): Promise<RiskoffEtfReturns | null> {
  const pairs = await Promise.all(
    RISKOFF_ETF_SYMBOLS.map(async (symbol) => {
      const bars = await fetchMassiveDailyBars(symbol);
      return [symbol, bars] as const;
    }),
  );
  if (pairs.every(([, bars]) => !bars)) return null;
  const bars: Partial<Record<RiskoffEtfSymbol, DailyBar[] | null | undefined>> = {};
  for (const [symbol, series] of pairs) bars[symbol] = series;
  return riskoffEtfReturnsFromBars(bars);
}
