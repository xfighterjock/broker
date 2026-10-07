import {
  DEFAULT_SLEEVE_EQUITY_USD,
  RISKOFF_DURATION_NOTIONAL_FRAC,
  RISKOFF_DURATION_STOP_MUL,
  RISKOFF_DURATION_SYMBOLS,
  type RiskoffDurationSymbol,
} from "../../shared/constants";
import type { Position, SleeveCard } from "../../shared/types";
import { openRiskoffEtfPositions, riskoffSleeveLossCapHit, sizeRiskoffEtfShares } from "./riskoffEtf";

export type RiskoffDurationBuy = {
  sleeveId: "riskoff";
  symbol: RiskoffDurationSymbol;
  side: "Buy";
  qty: number;
  stopPrice: number;
  thesis: string;
  gatedDuration: true;
};

export type RiskoffDurationSell = {
  sleeveId: "riskoff";
  symbol: string;
  reason: string;
};

export type RiskoffDurationDecision = {
  symbol: RiskoffDurationSymbol | null;
  reason: string;
  sells: RiskoffDurationSell[];
  buy: RiskoffDurationBuy | null;
};

export function isRiskoffDurationSymbol(symbol: string): symbol is RiskoffDurationSymbol {
  return (RISKOFF_DURATION_SYMBOLS as readonly string[]).includes(symbol.trim().toUpperCase());
}

export function isRiskoffDurationPosition(p: Position): boolean {
  return p.gatedDuration === true;
}

/** Open gated-duration TLT/IEF lots. Excludes the 63d RS overlay. */
export function openRiskoffDurationPositions(positions: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of positions) {
    if (p.side === "Flat" || p.qty <= 0) continue;
    if (p.sleeveId !== "riskoff") continue;
    if (p.vertical || p.overlay) continue;
    if (!p.gatedDuration) continue;
    if (!isRiskoffDurationSymbol(p.symbol)) continue;
    out.push(p);
  }
  return out;
}

/** Overlay already long TLT or IEF — duration stays flat (no second lot). */
export function overlayHoldsDurationName(positions: Position[]): boolean {
  for (const p of openRiskoffEtfPositions(positions)) {
    if (isRiskoffDurationSymbol(p.symbol)) return true;
  }
  return false;
}

/**
 * RISK OFF + SPY known below 200dma + dollar veto clear.
 * Null spyAbove200 or dollarVeto fails closed (no new duration long).
 * Null is not "known below".
 */
export function riskoffDurationAllowed(
  riskOn: boolean,
  spyAbove200?: boolean | null,
  dollarVeto?: boolean | null,
): boolean {
  return riskOn === false && spyAbove200 === false && dollarVeto === false;
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

function pickDurationQuote(
  quotes: Map<string, number>,
  equityUsd = DEFAULT_SLEEVE_EQUITY_USD,
): { symbol: RiskoffDurationSymbol; last: number; qty: number } | null {
  for (const symbol of RISKOFF_DURATION_SYMBOLS) {
    const last = quotes.get(symbol);
    if (last === undefined) continue;
    const qty = sizeRiskoffEtfShares(last, equityUsd, RISKOFF_DURATION_NOTIONAL_FRAC);
    if (qty < 1) continue;
    return { symbol, last, qty };
  }
  return null;
}

function flattenOpen(open: Position[], reason: string): RiskoffDurationDecision {
  return {
    symbol: null,
    reason,
    sells: open.map((p) => ({ sleeveId: "riskoff" as const, symbol: p.symbol, reason })),
    buy: null,
  };
}

/** Keep an open gated-duration lot. A missing check must not sell it. */
function holdOpen(open: Position[], reason: string): RiskoffDurationDecision {
  const held = open.find((p) => isRiskoffDurationSymbol(p.symbol));
  return {
    symbol: held && isRiskoffDurationSymbol(held.symbol) ? held.symbol : null,
    reason,
    sells: [],
    buy: null,
  };
}

/**
 * dollarVeto true with a present UUP 20d print is a measured spike.
 * dollarVeto true only because uup20dPct is null is a missing series — hold.
 * Omitting uup20dPct keeps the boolean (callers that pass dollarVeto: true alone).
 */
function measuredDollarVeto(dollarVeto?: boolean | null, uup20dPct?: number | null): boolean {
  if (dollarVeto !== true) return false;
  if (uup20dPct === null) return false;
  return true;
}

export function decideRiskoffDuration(input: {
  riskOn: boolean;
  spyAbove200?: boolean | null;
  dollarVeto?: boolean | null;
  /**
   * UUP 20-session return from the risk badge. Null + dollarVeto true means
   * the veto is the missing-series fail-closed, not a measured spike, so an
   * open duration lot is held. Omit to honor dollarVeto as given.
   */
  uup20dPct?: number | null;
  positions: Position[];
  sleeve: SleeveCard;
  quotes: Array<{ symbol: string; last: number }>;
  /** RS overlay held/winner — skip duration when that name is already TLT or IEF. */
  overlayWinner?: string | null;
  /** Top-2 overlay names; skip duration if any is TLT or IEF. */
  overlayWinners?: string[] | null;
  /**
   * Same blotter book as the overlay cap (sleeveBooks.riskoff daily / total).
   * Omit and only realized P/L is checked.
   */
  sleeveBook?: { dailyPnlUsd?: number | null; totalPnlUsd?: number | null } | null;
}): RiskoffDurationDecision {
  const open = openRiskoffDurationPositions(input.positions);

  if (input.riskOn) {
    return flattenOpen(open, "risk on: flatten gated duration");
  }
  if (riskoffSleeveLossCapHit(input.sleeve, input.sleeveBook)) {
    return flattenOpen(open, "sleeve loss cap");
  }
  if (input.spyAbove200 === true) {
    return flattenOpen(open, "SPY above 200dma: flatten gated duration");
  }
  if (measuredDollarVeto(input.dollarVeto, input.uup20dPct)) {
    return flattenOpen(open, "dollar veto: flatten gated duration");
  }
  if (typeof input.spyAbove200 !== "boolean") {
    return holdOpen(open, "missing spyAbove200: hold gated duration");
  }
  if (typeof input.dollarVeto !== "boolean" || (input.dollarVeto === true && input.uup20dPct === null)) {
    return holdOpen(open, "missing dollarVeto: hold gated duration");
  }
  const overlayNames = [
    ...(input.overlayWinners ?? []),
    ...(input.overlayWinner != null ? [input.overlayWinner] : []),
  ];
  if (
    overlayHoldsDurationName(input.positions) ||
    overlayNames.some((s) => isRiskoffDurationSymbol(s))
  ) {
    return flattenOpen(open, "overlay already long TLT/IEF");
  }

  const picked = pickDurationQuote(lastBySymbol(input.quotes));
  if (!picked) {
    return flattenOpen(open, "TLT/IEF unquoted: cash");
  }

  const extras = open.filter((p) => p.symbol.toUpperCase() !== picked.symbol);
  const held = open.find((p) => p.symbol.toUpperCase() === picked.symbol);
  const sells: RiskoffDurationSell[] = extras.map((p) => ({
    sleeveId: "riskoff",
    symbol: p.symbol,
    reason: `rotate gated duration to ${picked.symbol}`,
  }));

  if (held && held.qty > 0) {
    return { symbol: picked.symbol, reason: `hold ${picked.symbol}`, sells, buy: null };
  }

  return {
    symbol: picked.symbol,
    reason: `buy ${picked.symbol}`,
    sells,
    buy: {
      sleeveId: "riskoff",
      symbol: picked.symbol,
      side: "Buy",
      qty: picked.qty,
      stopPrice: picked.last * RISKOFF_DURATION_STOP_MUL,
      thesis: `auto risk-off gated duration ${picked.symbol} (SPY below 200, dollar clear)`,
      gatedDuration: true,
    },
  };
}
