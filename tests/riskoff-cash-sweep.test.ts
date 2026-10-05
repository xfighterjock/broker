import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_SLEEVE_EQUITY_USD,
  MAX_AUTO_RISKOFF_VERTICALS,
  OPTIONS_DEBIT_CAP_FRAC,
  OPTIONS_MULTIPLIER,
  RISKOFF_DURATION_NOTIONAL_FRAC,
  RISKOFF_ETF_NOTIONAL_FRAC,
  RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED,
  RISKOFF_ETF_RESIZE_NOTIONAL_FRAC,
  RISKOFF_ETF_SYMBOLS,
} from "../shared/constants";
import type { Position, SleeveCard, VerticalMeta, WorkingOrder } from "../shared/types";
import { defaultSleeves, emptyPaperStats } from "../shared/types";
import { applyCashCredit, detectStopHits } from "../server/src/paper";
import { MockBroker } from "../server/src/mockBroker";
import { parseMassiveCashDividends } from "../server/src/massive";
import {
  decideRiskoffEtf,
  emptyRiskoffEtfAbove200,
  emptyRiskoffEtfReturns,
  openRiskoffEtfPositions,
  resetRiskoffEtfMissingBarsMisses,
} from "../server/src/riskoffEtf";
import {
  decideRiskoffCashSweep,
  resetRiskoffCashSweepClock,
  riskoffPutReserveUsd,
  riskoffSweepReserve,
  sweepSharesToFund,
} from "../server/src/riskoffCashSweep";
import {
  planRiskoffDistributionCredits,
  resetRiskoffDistributionCredits,
} from "../server/src/riskoffDistributions";

const CLOSE = new Date("2026-09-09T20:05:00.000Z");
const MIDDAY = new Date("2026-09-09T15:00:00.000Z");

function sleeve(): SleeveCard {
  return defaultSleeves().riskoff;
}

function long(
  symbol: string,
  qty: number,
  avg: number,
  extra: Partial<Position> = {},
): Position {
  return {
    id: `${symbol}-${extra.cashSweep ? "sweep" : extra.gatedDuration ? "dur" : "lot"}`,
    symbol,
    root: null,
    qty,
    side: "Long",
    avgPrice: avg,
    unrealizedPnl: 0,
    gated: false,
    sleeveId: "riskoff",
    ...extra,
  };
}

function putDebit(debitPerShare: number): Position {
  const vertical = {
    kind: "debit-vertical",
    right: "P",
    expiry: "2026-10-16",
    underlying: "SPY",
    quoteSymbol: "SPY",
    qty: 1,
    netDebitPerShare: debitPerShare,
    netDebitPaid: debitPerShare * OPTIONS_MULTIPLIER,
  } as VerticalMeta;
  return long("SPY 2026-10-16 P 500/495", 1, debitPerShare, { vertical });
}

beforeEach(() => {
  resetRiskoffCashSweepClock();
  resetRiskoffEtfMissingBarsMisses();
  resetRiskoffDistributionCredits();
});

describe("risk-off idle-cash BIL sweep", () => {
  it("reserves put cap and duration in HYG-only (60% overlay)", () => {
    const equity = DEFAULT_SLEEVE_EQUITY_USD;
    const overlay = equity * RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED;
    const putBudget = MAX_AUTO_RISKOFF_VERTICALS * OPTIONS_DEBIT_CAP_FRAC * equity;
    const durationBudget = equity * RISKOFF_DURATION_NOTIONAL_FRAC;
    const reserve = riskoffSweepReserve({
      equityUsd: equity,
      nonSweepMarketValueUsd: overlay,
      openPutDebitUsd: 0,
      durationMarketValueUsd: 0,
    });
    expect(reserve.putReserveUsd).toBe(putBudget);
    expect(reserve.durationReserveUsd).toBe(durationBudget);
    expect(reserve.reserveUsd).toBe(26_000);
    expect(reserve.targetUsd).toBe(14_000);

    const decision = decideRiskoffCashSweep({
      riskOn: false,
      positions: [long("FTLS", overlay / 100, 100)],
      sleeve: sleeve(),
      quotes: [
        { symbol: "FTLS", last: 100 },
        { symbol: "BIL", last: 100 },
      ],
      bilBarsOk: true,
      now: CLOSE,
      lastSweepYmd: null,
    });
    expect(decision.reserveUsd).toBe(26_000);
    expect(decision.targetUsd).toBe(14_000);
    expect(decision.buy?.cashSweep).toBe(true);
    expect(decision.buy?.symbol).toBe("BIL");
    expect(decision.buy?.qty).toBe(140);
    expect(decision.sells).toEqual([]);
    expect(decision.reason).toBe("buy cash sweep");
  });

  it("reserves the put budget when SPY is below 200 (40% overlay + duration + puts)", () => {
    const equity = DEFAULT_SLEEVE_EQUITY_USD;
    const overlay = equity * RISKOFF_ETF_NOTIONAL_FRAC;
    const duration = equity * RISKOFF_DURATION_NOTIONAL_FRAC;
    const putMv = 2_000;
    const unfilled = riskoffSweepReserve({
      equityUsd: equity,
      nonSweepMarketValueUsd: overlay,
      openPutDebitUsd: 0,
      durationMarketValueUsd: 0,
    });
    expect(unfilled.reserveUsd).toBe(26_000);
    expect(unfilled.targetUsd).toBe(34_000);
    expect(riskoffPutReserveUsd(equity, 0)).toBe(6_000);

    const heldDuration = riskoffSweepReserve({
      equityUsd: equity,
      nonSweepMarketValueUsd: overlay + duration,
      openPutDebitUsd: 0,
      durationMarketValueUsd: duration,
    });
    expect(heldDuration.durationReserveUsd).toBe(0);
    expect(heldDuration.putReserveUsd).toBe(6_000);
    expect(heldDuration.targetUsd).toBe(34_000);

    const withPuts = riskoffSweepReserve({
      equityUsd: equity,
      nonSweepMarketValueUsd: overlay + duration + putMv,
      openPutDebitUsd: putMv,
      durationMarketValueUsd: duration,
    });
    expect(withPuts.putReserveUsd).toBe(4_000);
    expect(withPuts.reserveUsd).toBe(4_000);
    expect(withPuts.targetUsd).toBe(34_000);

    const decision = decideRiskoffCashSweep({
      riskOn: false,
      positions: [
        long("UUP", overlay / 100, 100),
        long("TLT", duration / 100, 100, { gatedDuration: true }),
        putDebit(putMv / OPTIONS_MULTIPLIER),
      ],
      sleeve: sleeve(),
      quotes: [
        { symbol: "UUP", last: 100 },
        { symbol: "TLT", last: 100 },
        { symbol: "BIL", last: 100 },
      ],
      bilBarsOk: true,
      now: CLOSE,
      lastSweepYmd: null,
    });
    expect(decision.targetUsd).toBe(34_000);
    expect(decision.reserveUsd).toBe(4_000);
    expect(decision.buy?.qty).toBe(340);
    expect(decision.buy?.cashSweep).toBe(true);
  });

  it("sells sweep BIL first to fund a put debit", () => {
    const qty = sweepSharesToFund({
      neededUsd: 2_500,
      freeCashUsd: 1_000,
      sweepQty: 100,
      bilLast: 91.5,
    });
    expect(qty).toBe(17);
    expect(17 * 91.5).toBeGreaterThanOrEqual(1_500);
    expect(
      sweepSharesToFund({
        neededUsd: 500,
        freeCashUsd: 1_000,
        sweepQty: 100,
        bilLast: 91.5,
      }),
    ).toBe(0);
    expect(
      sweepSharesToFund({
        neededUsd: 50_000,
        freeCashUsd: 0,
        sweepQty: 10,
        bilLast: 100,
      }),
    ).toBe(10);
  });

  it("does not sweep when BIL bars or the quote are missing", () => {
    const held = [long("BIL", 50, 100, { cashSweep: true }), long("FTLS", 600, 100)];
    const noQuote = decideRiskoffCashSweep({
      riskOn: false,
      positions: held,
      sleeve: sleeve(),
      quotes: [{ symbol: "FTLS", last: 100 }],
      bilBarsOk: true,
      now: CLOSE,
      lastSweepYmd: null,
    });
    expect(noQuote.buy).toBeNull();
    expect(noQuote.sells).toEqual([]);
    expect(noQuote.reason).toBe("BIL unquoted: cash");

    const noBarsFlat = decideRiskoffCashSweep({
      riskOn: false,
      positions: [long("FTLS", 600, 100)],
      sleeve: sleeve(),
      quotes: [{ symbol: "BIL", last: 100 }],
      bilBarsOk: false,
      now: CLOSE,
      lastSweepYmd: null,
    });
    expect(noBarsFlat.buy).toBeNull();
    expect(noBarsFlat.sells).toEqual([]);

    resetRiskoffCashSweepClock();
    const noBarsHeld = decideRiskoffCashSweep({
      riskOn: false,
      positions: held,
      sleeve: sleeve(),
      quotes: [
        { symbol: "BIL", last: 100 },
        { symbol: "FTLS", last: 100 },
      ],
      bilBarsOk: false,
      now: CLOSE,
    });
    expect(noBarsHeld.buy).toBeNull();
    expect(noBarsHeld.sells.map((s) => s.qty)).toEqual([50]);
    expect(noBarsHeld.sells[0].cashSweep).toBe(true);
    expect(noBarsHeld.reason).toBe("BIL bars missing: cash");

    const later = decideRiskoffCashSweep({
      riskOn: false,
      positions: [],
      sleeve: sleeve(),
      quotes: [{ symbol: "BIL", last: 100 }],
      bilBarsOk: true,
      now: CLOSE,
    });
    expect(later.buy).toBeNull();
    expect(later.reason).toMatch(/this NY session/);
  });

  it("flattens the sweep on RISK ON and leaves it alone midday", () => {
    const held = [long("BIL", 140, 100, { cashSweep: true }), long("FTLS", 600, 100)];
    const midday = decideRiskoffCashSweep({
      riskOn: false,
      positions: held,
      sleeve: sleeve(),
      quotes: [{ symbol: "BIL", last: 100 }],
      bilBarsOk: true,
      now: MIDDAY,
      lastSweepYmd: null,
    });
    expect(midday.buy).toBeNull();
    expect(midday.sells).toEqual([]);

    const on = decideRiskoffCashSweep({
      riskOn: true,
      positions: held,
      sleeve: sleeve(),
      quotes: [{ symbol: "BIL", last: 100 }],
      bilBarsOk: true,
      now: MIDDAY,
      lastSweepYmd: null,
    });
    expect(on.buy).toBeNull();
    expect(on.sells).toEqual([
      {
        sleeveId: "riskoff",
        symbol: "BIL",
        reason: "risk on: flatten cash sweep",
        cashSweep: true,
        qty: 140,
      },
    ]);
  });

  it("does not churn inside the resize band and does not treat sweep BIL as the overlay", () => {
    const dead = decideRiskoffCashSweep({
      riskOn: false,
      positions: [long("FTLS", 600, 100), long("BIL", 150, 100, { cashSweep: true })],
      sleeve: sleeve(),
      quotes: [
        { symbol: "FTLS", last: 100 },
        { symbol: "BIL", last: 100 },
      ],
      bilBarsOk: true,
      now: CLOSE,
      lastSweepYmd: null,
    });
    expect(dead.buy).toBeNull();
    expect(dead.sells).toEqual([]);
    expect(Math.abs(15_000 - 14_000)).toBeLessThan(
      DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_RESIZE_NOTIONAL_FRAC,
    );

    const sweep = long("BIL", 100, 91, { cashSweep: true });
    const overlay = long("BIL", 200, 91);
    expect(openRiskoffEtfPositions([sweep, overlay]).map((p) => p.id)).toEqual([overlay.id]);

    const broker = new MockBroker();
    broker.injectPosition({
      symbol: "BIL",
      qty: 200,
      side: "Long",
      avgPrice: 91,
      sleeveId: "riskoff",
    });
    broker.injectPosition({
      symbol: "BIL",
      qty: 100,
      side: "Long",
      avgPrice: 91,
      sleeveId: "riskoff",
      cashSweep: true,
    });
    const lots = broker.getPositionsSync().filter((p) => p.side !== "Flat");
    expect(lots).toHaveLength(2);
    expect(lots.filter((p) => p.cashSweep)).toHaveLength(1);

    const returns = emptyRiskoffEtfReturns();
    for (const s of RISKOFF_ETF_SYMBOLS) returns[s] = 0;
    returns.GLD = 0.2;
    const above = emptyRiskoffEtfAbove200();
    for (const s of RISKOFF_ETF_SYMBOLS) above[s] = true;
    const rs = decideRiskoffEtf({
      riskOn: false,
      positions: [sweep],
      sleeve: sleeve(),
      returns,
      quotes: [
        { symbol: "GLD", last: 180 },
        { symbol: "BIL", last: 91 },
      ],
      above200: above,
      returns21: returns,
      spyAbove200: false,
    });
    expect(rs.sells).toEqual([]);
    expect(rs.buys.every((b) => !("cashSweep" in b && b.cashSweep))).toBe(true);
    expect(openRiskoffEtfPositions([sweep])).toEqual([]);
  });

  it("does not stop-out the sweep when an overlay BIL stop is hit", () => {
    const overlay = long("BIL", 10, 100);
    const sweep = long("BIL", 40, 100, { cashSweep: true, id: "bil-sweep" });
    const stop: WorkingOrder = {
      id: "stop-1",
      symbol: "BIL",
      root: null,
      type: "StopMarket",
      side: "Sell",
      qty: 10,
      stopPrice: 92,
      state: "Working",
      gated: false,
      sleeveId: "riskoff",
    };
    const hits = detectStopHits(
      [overlay, sweep],
      [stop],
      [
        {
          symbol: "BIL",
          last: 90,
          prevClose: 100,
          change: -10,
          changePct: -10,
          asOf: null,
          exchange: null,
          delayed: true,
          source: "massive",
        },
      ],
    );
    expect(hits.map((h) => h.position.id)).toEqual([overlay.id]);
  });
});

describe("risk-off ETF cash distributions", () => {
  it("parses Massive cash dividends and drops rows that are not a positive USD cash amount", () => {
    expect(parseMassiveCashDividends({ status: "OK" })).toBeNull();
    const rows = parseMassiveCashDividends({
      results: [
        { ticker: "BIL", ex_dividend_date: "2026-10-05", cash_amount: 0.321, currency: "USD" },
        { ticker: "BIL", ex_dividend_date: "2026-10-05", cash_amount: 0 },
        { ticker: "FTLS", ex_dividend_date: "2026-10-05", currency: "USD" },
        { ticker: "UUP", ex_dividend_date: "2026-10-05", cash_amount: 0.2, currency: "EUR" },
        { ticker: "GLD", ex_dividend_date: "not-a-date", cash_amount: 0.1 },
      ],
    });
    expect(rows).toEqual([
      { ticker: "BIL", exDate: "2026-10-05", cashAmount: 0.321 },
    ]);
  });

  it("credits qty × cash once per symbol, ex-date, and sleeve", () => {
    const positions = [
      long("BIL", 80, 91, { cashSweep: true }),
      long("BIL", 20, 91),
      long("FTLS", 10, 60),
    ];
    const distributions = [
      { ticker: "BIL", exDate: "2026-10-05", cashAmount: 0.32 },
      { ticker: "FTLS", exDate: "2026-10-05", cashAmount: 0.1 },
      { ticker: "BIL", exDate: "2026-09-01", cashAmount: 0.3 },
      { ticker: "UUP", exDate: "2026-10-05", cashAmount: 0.2 },
    ];
    const first = planRiskoffDistributionCredits({
      positions,
      distributions,
      sessionDate: "2026-10-05",
      credited: new Set(),
    });
    expect(first.map((c) => [c.symbol, c.qty, c.creditUsd])).toEqual([
      ["BIL", 100, 32],
      ["FTLS", 10, 1],
    ]);
    expect(first[0].note).toContain("riskoff|BIL|2026-10-05");
    const credited = new Set(first.map((c) => c.key));
    const second = planRiskoffDistributionCredits({
      positions,
      distributions,
      sessionDate: "2026-10-05",
      credited,
    });
    expect(second).toEqual([]);

    const paper = applyCashCredit(emptyPaperStats(), 32);
    expect(paper.realizedPnlUsd).toBe(32);
    expect(paper.trades).toBe(0);
    expect(paper.wins).toBe(0);
  });
});
