import {
  DEFAULT_SLEEVE_EQUITY_USD,
  MAX_AUTO_RISKOFF_VERTICALS,
  OPTIONS_DEBIT_CAP_FRAC,
  OPTIONS_MULTIPLIER,
  RISKOFF_DURATION_NOTIONAL_FRAC,
  RISKOFF_ETF_CASH_SYMBOL,
  RISKOFF_ETF_RESIZE_NOTIONAL_FRAC,
  RISKOFF_ETF_STOP_MUL,
} from "../../shared/constants";
import type { Position, SleeveCard } from "../../shared/types";
import { overlayLotNeedsResize, riskoffEtfNyYmd, riskoffEtfRebalanceDue } from "./riskoffEtf";

export type RiskoffCashSweepSell = {
  sleeveId: "riskoff";
  symbol: typeof RISKOFF_ETF_CASH_SYMBOL;
  reason: string;
  cashSweep: true;
  qty: number;
};

export type RiskoffCashSweepBuy = {
  sleeveId: "riskoff";
  symbol: typeof RISKOFF_ETF_CASH_SYMBOL;
  side: "Buy";
  qty: number;
  stopPrice: number;
  thesis: string;
  cashSweep: true;
};

export type RiskoffCashSweepDecision = {
  reason: string;
  sells: RiskoffCashSweepSell[];
  buy: RiskoffCashSweepBuy | null;
  /** Cash kept back for unused put-debit cap plus unfunded duration. */
  reserveUsd: number;
  /** Idle cash the sweep would hold after the reserve. */
  targetUsd: number;
};

/** NY date of the last cash-close sweep resize. Process-local. Not the overlay clock. */
let lastSweepYmd: string | null = null;

export function resetRiskoffCashSweepClock(): void {
  lastSweepYmd = null;
}

export function isRiskoffCashSweepPosition(p: Position): boolean {
  return p.cashSweep === true && p.sleeveId === "riskoff";
}

export function openRiskoffCashSweepPositions(positions: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of positions) {
    if (p.side === "Flat" || p.qty <= 0) continue;
    if (!isRiskoffCashSweepPosition(p)) continue;
    if (p.symbol.trim().toUpperCase() !== RISKOFF_ETF_CASH_SYMBOL) continue;
    out.push(p);
  }
  return out;
}

function quoteLast(quotes: Array<{ symbol: string; last: number }>, symbol: string): number | null {
  const want = symbol.trim().toUpperCase();
  for (const q of quotes) {
    if (q.symbol.trim().toUpperCase() !== want) continue;
    if (Number.isFinite(q.last) && q.last > 0) return q.last;
  }
  return null;
}

/** Dollar mark of one open lot. Verticals use the debit package; stocks use last. */
export function riskoffLotMarketValueUsd(p: Position, last: number | null): number {
  if (p.side === "Flat" || p.qty <= 0) return 0;
  const unreal = Number.isFinite(p.unrealizedPnl) ? p.unrealizedPnl : 0;
  if (p.vertical) {
    const debit = p.avgPrice * p.qty * OPTIONS_MULTIPLIER;
    return debit + unreal;
  }
  if (last !== null && last > 0) return last * p.qty;
  return p.avgPrice * p.qty + unreal;
}

export function riskoffSleeveEquityUsd(sleeve: SleeveCard, positions: Position[]): number {
  let unrealized = 0;
  for (const p of positions) {
    if (p.sleeveId !== "riskoff") continue;
    if (p.side === "Flat" || p.qty <= 0) continue;
    if (Number.isFinite(p.unrealizedPnl)) unrealized += p.unrealizedPnl;
  }
  const realized = Number.isFinite(sleeve.paper.realizedPnlUsd) ? sleeve.paper.realizedPnlUsd : 0;
  return DEFAULT_SLEEVE_EQUITY_USD + realized + unrealized;
}

/**
 * Full put-debit budget: auto cap count × OPTIONS_DEBIT_CAP_FRAC of sleeve equity.
 * Open put debits already consume part of that budget.
 */
export function riskoffPutReserveUsd(equityUsd: number, openPutDebitUsd: number): number {
  if (!(equityUsd > 0)) return 0;
  const budget = MAX_AUTO_RISKOFF_VERTICALS * OPTIONS_DEBIT_CAP_FRAC * equityUsd;
  const used = Number.isFinite(openPutDebitUsd) && openPutDebitUsd > 0 ? openPutDebitUsd : 0;
  return Math.max(0, budget - used);
}

/**
 * Gated duration budget (20% of the $100k book, same basis as the duration buy)
 * minus duration already held. Kept even while SPY is above 200 so a break
 * can fund TLT/IEF without selling the sweep first. The 60%→40% overlay cut
 * is a separate sale; this reserve does not depend on it.
 */
export function riskoffDurationReserveUsd(durationMarketValueUsd: number): number {
  const budget = DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_DURATION_NOTIONAL_FRAC;
  const held =
    Number.isFinite(durationMarketValueUsd) && durationMarketValueUsd > 0
      ? durationMarketValueUsd
      : 0;
  return Math.max(0, budget - held);
}

export type RiskoffSweepReserve = {
  equityUsd: number;
  nonSweepMarketValueUsd: number;
  openPutDebitUsd: number;
  durationMarketValueUsd: number;
  putReserveUsd: number;
  durationReserveUsd: number;
  reserveUsd: number;
  targetUsd: number;
};

/** Idle cash above the put reserve and the unfunded duration book. */
export function riskoffSweepReserve(input: {
  equityUsd: number;
  nonSweepMarketValueUsd: number;
  openPutDebitUsd: number;
  durationMarketValueUsd: number;
}): RiskoffSweepReserve {
  const equityUsd = Number.isFinite(input.equityUsd) ? input.equityUsd : 0;
  const nonSweep = Number.isFinite(input.nonSweepMarketValueUsd)
    ? Math.max(0, input.nonSweepMarketValueUsd)
    : 0;
  const putReserveUsd = riskoffPutReserveUsd(equityUsd, input.openPutDebitUsd);
  const durationReserveUsd = riskoffDurationReserveUsd(input.durationMarketValueUsd);
  const reserveUsd = putReserveUsd + durationReserveUsd;
  const targetUsd = Math.max(0, equityUsd - nonSweep - reserveUsd);
  return {
    equityUsd,
    nonSweepMarketValueUsd: nonSweep,
    openPutDebitUsd: Math.max(0, input.openPutDebitUsd || 0),
    durationMarketValueUsd: Math.max(0, input.durationMarketValueUsd || 0),
    putReserveUsd,
    durationReserveUsd,
    reserveUsd,
    targetUsd,
  };
}

function bookMarks(
  positions: Position[],
  quotes: Array<{ symbol: string; last: number }>,
): { nonSweep: number; putDebit: number; duration: number } {
  let nonSweep = 0;
  let putDebit = 0;
  let duration = 0;
  for (const p of positions) {
    if (p.sleeveId !== "riskoff" || p.side === "Flat" || p.qty <= 0) continue;
    if (isRiskoffCashSweepPosition(p)) continue;
    const last = quoteLast(quotes, p.symbol);
    const mv = riskoffLotMarketValueUsd(p, last);
    nonSweep += mv;
    if (p.gatedDuration) duration += mv;
    if (p.vertical?.right === "P") putDebit += mv;
  }
  return { nonSweep, putDebit, duration };
}

/**
 * Shares of sweep BIL to sell so `neededUsd` can be paid from cash.
 * Zero when free cash already covers the debit. Never sells more than the sweep lot.
 */
export function sweepSharesToFund(input: {
  neededUsd: number;
  freeCashUsd: number;
  sweepQty: number;
  bilLast: number;
}): number {
  if (!(input.neededUsd > input.freeCashUsd)) return 0;
  if (!(input.sweepQty > 0) || !(input.bilLast > 0) || !Number.isFinite(input.bilLast)) return 0;
  const shortfall = input.neededUsd - input.freeCashUsd;
  const qty = Math.ceil(shortfall / input.bilLast - 1e-9);
  if (!(qty > 0)) return 0;
  return Math.min(input.sweepQty, qty);
}

export function riskoffFreeCashUsd(
  equityUsd: number,
  positions: Position[],
  quotes: Array<{ symbol: string; last: number }>,
): number {
  let mv = 0;
  for (const p of positions) {
    if (p.sleeveId !== "riskoff" || p.side === "Flat" || p.qty <= 0) continue;
    mv += riskoffLotMarketValueUsd(p, quoteLast(quotes, p.symbol));
  }
  return equityUsd - mv;
}

function sweepNeedsTrade(heldQty: number, targetQty: number, last: number): boolean {
  if (heldQty < 1) {
    if (targetQty < 1) return false;
    return targetQty * last >= DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_RESIZE_NOTIONAL_FRAC;
  }
  return overlayLotNeedsResize(heldQty, targetQty, last);
}

function emptyDecision(
  reason: string,
  reserve: RiskoffSweepReserve | null,
): RiskoffCashSweepDecision {
  return {
    reason,
    sells: [],
    buy: null,
    reserveUsd: reserve?.reserveUsd ?? 0,
    targetUsd: reserve?.targetUsd ?? 0,
  };
}

function flattenSweep(open: Position[], reason: string): RiskoffCashSweepDecision {
  const sells: RiskoffCashSweepSell[] = [];
  for (const p of open) {
    if (p.qty < 1) continue;
    sells.push({
      sleeveId: "riskoff",
      symbol: RISKOFF_ETF_CASH_SYMBOL,
      reason,
      cashSweep: true,
      qty: p.qty,
    });
  }
  return { reason, sells, buy: null, reserveUsd: 0, targetUsd: 0 };
}

/**
 * Idle-cash T-bill sweep for the risk-off sleeve. Paper / MockBroker only.
 * Runs on the same NY cash-close clock as the overlay, with its own stamp.
 * Does not change overlay RS, hysteresis, top-2, inverse-vol, min-hold, or
 * the beat-BIL hurdle. BIL is not 200-filtered here and is not min-held.
 * Missing BIL bars or quote: no buy (stay cash). A missing quote also cannot
 * sell. A missing bar at the cash close with a live quote flattens the sweep
 * for that session.
 */
export function decideRiskoffCashSweep(input: {
  riskOn: boolean;
  positions: Position[];
  sleeve: SleeveCard;
  quotes: Array<{ symbol: string; last: number }>;
  /** Finite BIL daily bars (a finite BIL return from the overlay fetch). */
  bilBarsOk: boolean;
  now?: Date | null;
  /** Previous sweep session. Omit to use process memory. Null means not yet. */
  lastSweepYmd?: string | null;
}): RiskoffCashSweepDecision {
  const open = openRiskoffCashSweepPositions(input.positions);
  if (input.riskOn) {
    return flattenSweep(open, "risk on: flatten cash sweep");
  }

  const now = input.now ?? null;
  if (!now) {
    return emptyDecision("cash sweep waits for NY cash close", null);
  }
  const prev = input.lastSweepYmd !== undefined ? input.lastSweepYmd : lastSweepYmd;
  if (!riskoffEtfRebalanceDue(now, prev)) {
    const stampedToday = prev !== null && prev === riskoffEtfNyYmd(now);
    if (stampedToday) {
      return emptyDecision(
        open.length
          ? "hold cash sweep: rebalanced this NY session"
          : "cash sweep already rebalanced this NY session",
        null,
      );
    }
    return emptyDecision(
      open.length ? "hold cash sweep" : "cash sweep waits for NY cash close",
      null,
    );
  }

  const bilLast = quoteLast(input.quotes, RISKOFF_ETF_CASH_SYMBOL);
  if (bilLast === null) {
    return emptyDecision("BIL unquoted: cash", null);
  }

  const ymd = riskoffEtfNyYmd(now);
  if (input.lastSweepYmd === undefined) lastSweepYmd = ymd;

  if (!input.bilBarsOk) {
    return flattenSweep(open, "BIL bars missing: cash");
  }

  const marks = bookMarks(input.positions, input.quotes);
  const reserve = riskoffSweepReserve({
    equityUsd: riskoffSleeveEquityUsd(input.sleeve, input.positions),
    nonSweepMarketValueUsd: marks.nonSweep,
    openPutDebitUsd: marks.putDebit,
    durationMarketValueUsd: marks.duration,
  });
  const heldQty = open.reduce((s, p) => s + p.qty, 0);
  const targetQty = Math.floor(reserve.targetUsd / bilLast);
  if (!sweepNeedsTrade(heldQty, targetQty, bilLast)) {
    return emptyDecision(heldQty > 0 ? "hold cash sweep" : "cash sweep below resize band", reserve);
  }
  if (targetQty > heldQty) {
    const qty = targetQty - heldQty;
    return {
      reason: heldQty > 0 ? "resize cash sweep" : "buy cash sweep",
      sells: [],
      buy: {
        sleeveId: "riskoff",
        symbol: RISKOFF_ETF_CASH_SYMBOL,
        side: "Buy",
        qty,
        stopPrice: bilLast * RISKOFF_ETF_STOP_MUL,
        thesis: "auto risk-off cash sweep BIL (idle T-bill)",
        cashSweep: true,
      },
      reserveUsd: reserve.reserveUsd,
      targetUsd: reserve.targetUsd,
    };
  }
  const qty = heldQty - Math.max(0, targetQty);
  return {
    reason: targetQty < 1 ? "flatten cash sweep" : "resize cash sweep",
    sells: [
      {
        sleeveId: "riskoff",
        symbol: RISKOFF_ETF_CASH_SYMBOL,
        reason: targetQty < 1 ? "flatten cash sweep" : "resize cash sweep",
        cashSweep: true,
        qty,
      },
    ],
    buy: null,
    reserveUsd: reserve.reserveUsd,
    targetUsd: reserve.targetUsd,
  };
}
