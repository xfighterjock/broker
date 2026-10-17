import { etParts } from "../../shared/clock";
import { cashSessionCloseMinute, cashSessionIsOpen } from "../../shared/marketSession";
import type { CspPutMeta, CspStatusView, GateMode, Position } from "../../shared/types";
import {
  CSP_SHADOW_RULES,
  applyShadowCheck,
  calendarDte,
  cspBuyFill,
  earningsExitDue,
  planCspEntry,
  putExpiresItm,
  shortPutPnlPerContract,
  summarizeShadowExits,
  twoXStopHit,
  type CspPlannedEntry,
  type CspShadowSummary,
  type ShadowMarket,
  type ShadowRow,
} from "./cspMath";

export interface CspCycleOrder {
  kind: "sell-put" | "buy-put" | "sell-shares";
  positionId?: string;
  symbol: string;
  qty: number;
  price: number;
  reason: string;
  entry?: CspPlannedEntry;
}

export interface CspCandidate {
  underlying: string;
  expiry: string;
  strike: number;
  bid: number;
  ask: number;
  iv: number | null;
  delta: number | null;
  oi: number | null;
  volume: number | null;
  signalOk: boolean;
  earningsOk: boolean;
}

export interface CspMark {
  mid: number | null;
  bid: number | null;
  ask: number | null;
  delta: number | null;
  underlyingPx: number | null;
  underlyingClose: number | null;
  spyClose: number | null;
  spySma200: number | null;
  dte: number | null;
}

export interface CspCycleCtx {
  now: Date;
  /** Passed through and ignored by planCspEntry. */
  riskOn: boolean;
  autoOn: boolean;
  gateEnabled: boolean;
  gateMode: GateMode;
  lossCapHit: boolean;
  equityUsd: number;
  positions: Position[];
  candidates: CspCandidate[];
  chainAvailable: boolean;
  /** True on the official close check. Premium rules also run intraday. */
  atClose: boolean;
  marks: Record<string, CspMark>;
  shadows: ShadowRow[];
}

export interface CspCycleResult {
  orders: CspCycleOrder[];
  shadows: ShadowRow[];
  skips: { symbol: string; reason: string }[];
  shadowSummary: CspShadowSummary[];
}

function isOpen(p: Position): boolean {
  return p.side !== "Flat" && p.qty > 0;
}

export function cspReservedUsd(positions: Position[]): number {
  let n = 0;
  for (const p of positions) {
    if (!isOpen(p) || !p.csp) continue;
    n += p.csp.reservedUsd;
  }
  return n;
}

export function cspAssignedMvUsd(positions: Position[]): number {
  let n = 0;
  for (const p of positions) {
    if (!isOpen(p) || !p.cspAssigned) continue;
    const px = p.avgPrice > 0 ? p.avgPrice : 0;
    n += px * p.qty;
  }
  return n;
}

function ymdEt(now: Date): string {
  const p = etParts(now);
  const m = String(p.month).padStart(2, "0");
  const d = String(p.day).padStart(2, "0");
  return `${p.year}-${m}-${d}`;
}

function shadowMarket(meta: CspPutMeta, mark: CspMark | undefined, atClose: boolean, now: Date): ShadowMarket {
  const dte = mark?.dte ?? calendarDte(ymdEt(now), meta.expiry);
  return {
    mid: mark?.mid ?? null,
    bid: mark?.bid ?? null,
    ask: mark?.ask ?? null,
    delta: mark?.delta ?? meta.delta,
    dte,
    underlyingPx: mark?.underlyingPx ?? null,
    underlyingClose: mark?.underlyingClose ?? null,
    spyClose: mark?.spyClose ?? null,
    spySma200: mark?.spySma200 ?? null,
    atClose,
    entryCredit: meta.entryPremium,
    swingLow: meta.swingLow,
  };
}

/**
 * Paper CSP pass. Live exit is the 2x mid stop, an earnings date that appears
 * inside the holding window, or expiration. Shadow rules only append rows.
 * New shorts call planCspEntry, which does not read riskOn.
 */
export function runCspDecisions(ctx: CspCycleCtx): CspCycleResult {
  const orders: CspCycleOrder[] = [];
  const skips: { symbol: string; reason: string }[] = [];
  let shadows = ctx.shadows.map((r) => ({ ...r }));
  const openPuts = ctx.positions.filter((p) => isOpen(p) && p.csp && p.sleeveId === "csp");

  for (const p of openPuts) {
    const meta = p.csp!;
    const mark = ctx.marks[p.id];
    const market = shadowMarket(meta, mark, ctx.atClose, ctx.now);
    const fill = cspBuyFill(market.bid, market.ask, market.mid);
    shadows = applyShadowCheck(shadows, p.id, market, ctx.now.toISOString());

    const earningsDue = earningsExitDue(meta.earningsDates ?? null, ymdEt(ctx.now), meta.entryYmd, meta.expiry);
    const dte = market.dte;
    const expired = dte !== null && dte <= 0;
    if (twoXStopHit(market.mid, meta.entryPremium) && fill !== null) {
      orders.push({
        kind: "buy-put",
        positionId: p.id,
        symbol: p.symbol,
        qty: meta.contracts,
        price: fill,
        reason: "2x stop",
      });
      continue;
    }
    if (earningsDue && fill !== null && !expired) {
      orders.push({
        kind: "buy-put",
        positionId: p.id,
        symbol: p.symbol,
        qty: meta.contracts,
        price: fill,
        reason: "earnings before expiry",
      });
      continue;
    }
    if (expired) {
      const px = market.underlyingClose ?? market.underlyingPx ?? meta.strike;
      if (putExpiresItm(px, meta.strike)) {
        orders.push({
          kind: "sell-shares",
          positionId: p.id,
          symbol: meta.underlying,
          qty: meta.contracts * 100,
          price: px,
          reason: "assignment sale next session is recorded at this expiry close for the paper book when the session is already the exit check",
        });
      } else {
        orders.push({
          kind: "buy-put",
          positionId: p.id,
          symbol: p.symbol,
          qty: meta.contracts,
          price: 0,
          reason: "expire worthless",
        });
      }
    }
  }

  const reserved = cspReservedUsd(ctx.positions);
  const assigned = cspAssignedMvUsd(ctx.positions);
  let openCount = openPuts.length;
  let reservedRunning = reserved;
  for (const cand of ctx.candidates) {
    const planned = planCspEntry({
      riskOn: ctx.riskOn,
      autoOn: ctx.autoOn,
      gateEnabled: ctx.gateEnabled,
      gateMode: ctx.gateMode,
      inCashSession: cashSessionIsOpen(ctx.now),
      chainAvailable: ctx.chainAvailable,
      lossCapHit: ctx.lossCapHit,
      equityUsd: ctx.equityUsd,
      reservedUsd: reservedRunning,
      assignedMvUsd: assigned,
      openPutCount: openCount,
      signalOk: cand.signalOk,
      earningsOk: cand.earningsOk,
      quote: {
        underlying: cand.underlying,
        expiry: cand.expiry,
        strike: cand.strike,
        bid: cand.bid,
        ask: cand.ask,
        iv: cand.iv,
        delta: cand.delta,
        oi: cand.oi,
        volume: cand.volume,
      },
    });
    if (!planned.entry) {
      skips.push({ symbol: cand.underlying, reason: planned.skip ?? "skip" });
      continue;
    }
    orders.push({
      kind: "sell-put",
      symbol: `${cand.underlying} ${cand.expiry} ${cand.strike}P`,
      qty: planned.entry.contracts,
      price: planned.entry.fill,
      reason: "csp entry",
      entry: planned.entry,
    });
    reservedRunning += planned.entry.reservedUsd;
    openCount += 1;
  }

  return {
    orders,
    shadows,
    skips,
    shadowSummary: summarizeShadowExits(shadows),
  };
}

/** Shadow rules that fired must not be turned into orders. */
export function shadowOrders(result: CspCycleResult): CspCycleOrder[] {
  return result.orders.filter((o) => o.reason.startsWith("shadow"));
}

export function emptyShadowRows(positionId: string): ShadowRow[] {
  return CSP_SHADOW_RULES.map((ruleId) => ({
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
  }));
}

export function stampActualPnl(rows: ShadowRow[], positionId: string, actualPerContract: number): ShadowRow[] {
  return rows.map((r) => {
    if (r.positionId !== positionId) return r;
    const pnl = r.pnl === null ? actualPerContract : r.pnl;
    return { ...r, pnl, finalActualPnl: actualPerContract };
  });
}

export function actualShortPutPnl(entry: number, exit: number): number {
  return shortPutPnlPerContract(entry, exit);
}

export function buildCspStatus(input: {
  equityUsd: number;
  realizedPnlUsd: number;
  positions: Position[];
  skips: Array<{ symbol: string; reason: string }>;
  signals: string[];
  recorder: CspStatusView["recorder"];
  shadows: ShadowRow[];
  now: Date;
}): CspStatusView {
  const openPuts = input.positions.filter((p) => isOpen(p) && p.csp && p.sleeveId === "csp");
  const reserved = cspReservedUsd(input.positions);
  const assignedMv = cspAssignedMvUsd(input.positions);
  const cash = Math.max(0, input.equityUsd - reserved - assignedMv);
  const summaries = summarizeShadowExits(input.shadows);
  return {
    equityUsd: input.equityUsd,
    cashUsd: cash,
    reservedUsd: reserved,
    utilizationPct: input.equityUsd > 0 ? ((reserved + assignedMv) / input.equityUsd) * 100 : 0,
    realizedPnlUsd: input.realizedPnlUsd,
    openPuts: openPuts.map((p) => {
      const meta = p.csp!;
      const dte = calendarDte(ymdEt(input.now), meta.expiry);
      const mark = p.unrealizedPnl;
      return {
        symbol: p.symbol,
        underlying: meta.underlying,
        strike: meta.strike,
        expiry: meta.expiry,
        dte,
        entryPremium: meta.entryPremium,
        mark: meta.mid,
        stop: meta.entryPremium * 2,
        pnlUsd: Number.isFinite(mark) ? mark : null,
        contracts: meta.contracts,
      };
    }),
    assigned: input.positions
      .filter((p) => isOpen(p) && p.cspAssigned && p.sleeveId === "csp")
      .map((p) => ({ symbol: p.symbol, qty: p.qty, avgPrice: p.avgPrice })),
    skips: input.skips.slice(-20),
    signals: input.signals.slice(-20),
    recorder: input.recorder,
    shadow: summaries.map((s) => ({
      ruleId: s.ruleId,
      count: s.count,
      winRate: s.winRate,
      totalPnl: s.totalPnl,
      avgPnl: s.avgPnl,
      vsActual: s.avgVsActual,
    })),
  };
}

/** Cash-session days only. 12:30–12:40 and 16:15–16:25 ET. */
export function cspRecorderSlot(now: Date): "mid" | "close" | null {
  const p = etParts(now);
  if (cashSessionCloseMinute(p.year, p.month, p.day) === null) return null;
  const minute = p.hour * 60 + p.minute;
  if (minute >= 12 * 60 + 30 && minute < 12 * 60 + 40) return "mid";
  if (minute >= 16 * 60 + 15 && minute < 16 * 60 + 25) return "close";
  return null;
}
