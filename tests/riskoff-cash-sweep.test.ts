import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
import type { OptionLeg, Position, SleeveCard, VerticalMeta, WorkingOrder } from "../shared/types";
import { defaultSleeves, emptyPaperStats } from "../shared/types";
import { applyCashCredit, detectStopHits } from "../server/src/paper";
import { MockBroker } from "../server/src/mockBroker";
import { riskoffEquityPutsAllowed, runAutopilot } from "../server/src/autopilot";
import { riskoffDurationAllowed } from "../server/src/riskoffDuration";
import { setPaperNow } from "../server/src/vertical";
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
  riskoffReserveLegReleased,
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

afterEach(() => {
  setPaperNow(null);
});

function gates(spyAbove200: boolean | null | undefined, dollarVeto: boolean | null = false) {
  return {
    spyAbove200,
    putsAllowed: riskoffEquityPutsAllowed(false, spyAbove200),
    durationAllowed: riskoffDurationAllowed(false, spyAbove200, dollarVeto),
  };
}

describe("risk-off idle-cash BIL sweep", () => {
  it("SPY above 200 releases the put and duration reserve and sweeps all idle cash", () => {
    const equity = DEFAULT_SLEEVE_EQUITY_USD;
    const overlay = equity * RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED;
    const above = gates(true);
    expect(above.putsAllowed).toBe(false);
    expect(above.durationAllowed).toBe(false);
    expect(riskoffReserveLegReleased(true, above.putsAllowed)).toBe(true);
    expect(riskoffReserveLegReleased(true, above.durationAllowed)).toBe(true);
    const reserve = riskoffSweepReserve({
      equityUsd: equity,
      nonSweepMarketValueUsd: overlay,
      openPutDebitUsd: 0,
      durationMarketValueUsd: 0,
      releasePutReserve: true,
      releaseDurationReserve: true,
    });
    expect(reserve.putReserveUsd).toBe(0);
    expect(reserve.durationReserveUsd).toBe(0);
    expect(reserve.reserveUsd).toBe(0);
    expect(reserve.targetUsd).toBe(40_000);

    const decision = decideRiskoffCashSweep({
      riskOn: false,
      ...above,
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
    expect(decision.reserveUsd).toBe(0);
    expect(decision.targetUsd).toBe(40_000);
    expect(decision.buy?.cashSweep).toBe(true);
    expect(decision.buy?.symbol).toBe("BIL");
    expect(decision.buy?.qty).toBe(400);
    expect(decision.sells).toEqual([]);
    expect(decision.reason).toBe("buy cash sweep");
  });

  it("keeps a leg's reserve when that gate still allows it with SPY above 200", () => {
    const equity = DEFAULT_SLEEVE_EQUITY_USD;
    const overlay = equity * RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED;
    const putBudget = MAX_AUTO_RISKOFF_VERTICALS * OPTIONS_DEBIT_CAP_FRAC * equity;
    expect(riskoffReserveLegReleased(true, true)).toBe(false);
    expect(riskoffReserveLegReleased(true, false)).toBe(true);
    const reserve = riskoffSweepReserve({
      equityUsd: equity,
      nonSweepMarketValueUsd: overlay,
      openPutDebitUsd: 0,
      durationMarketValueUsd: 0,
      releasePutReserve: riskoffReserveLegReleased(true, true),
      releaseDurationReserve: riskoffReserveLegReleased(true, false),
    });
    expect(reserve.putReserveUsd).toBe(putBudget);
    expect(reserve.durationReserveUsd).toBe(0);
    expect(reserve.reserveUsd).toBe(putBudget);
    expect(reserve.targetUsd).toBe(34_000);

    const decision = decideRiskoffCashSweep({
      riskOn: false,
      spyAbove200: true,
      putsAllowed: true,
      durationAllowed: false,
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
    expect(decision.reserveUsd).toBe(6_000);
    expect(decision.targetUsd).toBe(34_000);
    expect(decision.buy?.qty).toBe(340);
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

    const below = gates(false);
    expect(below.putsAllowed).toBe(true);
    expect(below.durationAllowed).toBe(true);
    expect(riskoffReserveLegReleased(false, false)).toBe(false);
    const vetoStillReserved = decideRiskoffCashSweep({
      riskOn: false,
      ...gates(false, true),
      positions: [long("UUP", overlay / 100, 100)],
      sleeve: sleeve(),
      quotes: [
        { symbol: "UUP", last: 100 },
        { symbol: "BIL", last: 100 },
      ],
      bilBarsOk: true,
      now: CLOSE,
      lastSweepYmd: null,
    });
    expect(gates(false, true).durationAllowed).toBe(false);
    expect(vetoStillReserved.reserveUsd).toBe(26_000);
    expect(vetoStillReserved.targetUsd).toBe(34_000);

    const decision = decideRiskoffCashSweep({
      riskOn: false,
      ...below,
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

  it("unknown SPY 200 fails closed to today's reserve", () => {
    const equity = DEFAULT_SLEEVE_EQUITY_USD;
    const overlay = equity * RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED;
    for (const spyAbove200 of [null, undefined] as const) {
      const unknown = gates(spyAbove200);
      expect(unknown.putsAllowed).toBe(false);
      expect(unknown.durationAllowed).toBe(false);
      expect(riskoffReserveLegReleased(spyAbove200, unknown.putsAllowed)).toBe(false);
      expect(riskoffReserveLegReleased(spyAbove200, unknown.durationAllowed)).toBe(false);
      const decision = decideRiskoffCashSweep({
        riskOn: false,
        ...unknown,
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
      expect(decision.buy?.qty).toBe(140);
    }
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
      ...gates(false),
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
    expect(dead.reserveUsd).toBe(26_000);
    expect(dead.targetUsd).toBe(14_000);
    expect(Math.abs(15_000 - 14_000)).toBeLessThan(
      DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_RESIZE_NOTIONAL_FRAC,
    );

    const releasedBand = decideRiskoffCashSweep({
      riskOn: false,
      ...gates(true),
      positions: [long("FTLS", 600, 100), long("BIL", 395, 100, { cashSweep: true })],
      sleeve: sleeve(),
      quotes: [
        { symbol: "FTLS", last: 100 },
        { symbol: "BIL", last: 100 },
      ],
      bilBarsOk: true,
      now: CLOSE,
      lastSweepYmd: null,
    });
    expect(releasedBand.reserveUsd).toBe(0);
    expect(releasedBand.targetUsd).toBe(40_000);
    expect(releasedBand.buy).toBeNull();
    expect(releasedBand.sells).toEqual([]);
    expect(Math.abs(39_500 - 40_000)).toBeLessThan(
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

  it("autopilot sweeps idle cash when SPY is above 200 and keeps the reserve otherwise", async () => {
    const returns = emptyRiskoffEtfReturns();
    returns.BIL = 0.01;
    async function sweepQty(spyAbove200: boolean | null): Promise<number[]> {
      resetRiskoffCashSweepClock();
      resetRiskoffEtfMissingBarsMisses();
      const placed: number[] = [];
      await runAutopilot({
        enabled: true,
        sleeveAuto: {
          day: false,
          momentum: false,
          ownership: false,
          options: false,
          riskoff: true,
        },
        getPositions: () => [long("FTLS", 600, 100)],
        getSleeves: () => defaultSleeves(),
        momentumRows: [],
        featureRows: [],
        scanReady: true,
        riskOn: false,
        riskChecks: { spyAbove200, hygAbove200: false, dollarVeto: false },
        riskoffEtfReturns: returns,
        riskoffEtfQuotes: [
          { symbol: "FTLS", last: 100 },
          { symbol: "BIL", last: 100 },
        ],
        now: CLOSE,
        place: async (b) => {
          if (b.cashSweep) placed.push(b.qty);
          return { ok: true };
        },
        close: async () => ({ ok: true }),
        log: () => {},
      });
      return placed;
    }
    expect(await sweepQty(true)).toEqual([400]);
    expect(await sweepQty(false)).toEqual([140]);
    expect(await sweepQty(null)).toEqual([140]);
  });

  it("a SPY break funds 3 put debits and duration by selling sweep BIL first", async () => {
    setPaperNow(new Date("2026-09-03T13:50:00.000Z"));
    const expiry = [
      { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" as const },
    ];
    const chain = (u: string, atm: number): OptionLeg[] => [
      leg(u, atm, 0.41, 0.42),
      leg(u, atm - 0.5, 0.19, 0.2),
    ];
    const positions: Position[] = [
      long("FTLS", 400, 100),
      long("BIL", 600, 100, { cashSweep: true }),
    ];
    const events: string[] = [];
    const result = await runBreakFunding({
      positions,
      bilQuoted: true,
      chain,
      expiry,
      events,
    });
    expect(events).toEqual([
      "fund:1",
      "put:HYG",
      "fund:1",
      "put:LQD",
      "fund:1",
      "put:JNK",
      "fund:200",
      "buy:TLT",
    ]);
    expect(result.verticals.map((v) => v.symbol)).toEqual(["HYG", "LQD", "JNK"]);
    expect(result.bought.map((b) => b.symbol)).toEqual(["TLT"]);
    expect(result.bought[0].gatedDuration).toBe(true);
    expect(positions.find((p) => p.cashSweep)?.qty).toBe(600 - 1 - 1 - 1 - 200);
  });

  it("a missing BIL quote falls back to the sweep average and still opens the entries", async () => {
    setPaperNow(new Date("2026-09-03T13:50:00.000Z"));
    const expiry = [
      { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" as const },
    ];
    const chain = (u: string, atm: number): OptionLeg[] => [
      leg(u, atm, 0.41, 0.42),
      leg(u, atm - 0.5, 0.19, 0.2),
    ];
    const positions: Position[] = [
      long("FTLS", 400, 100),
      long("BIL", 600, 100, { cashSweep: true }),
    ];
    const events: string[] = [];
    const result = await runBreakFunding({
      positions,
      bilQuoted: false,
      chain,
      expiry,
      events,
    });
    expect(events[0]).toBe("fund:1");
    expect(events.filter((e) => e.startsWith("put:"))).toEqual(["put:HYG", "put:LQD", "put:JNK"]);
    expect(events[events.length - 1]).toBe("buy:TLT");
    expect(result.verticals).toHaveLength(3);
    expect(result.bought.map((b) => b.symbol)).toEqual(["TLT"]);

    const unpriced: Position[] = [
      long("FTLS", 400, 100),
      long("BIL", 600, 0, { cashSweep: true }),
    ];
    const skipped: string[] = [];
    const logs: string[] = [];
    const still = await runBreakFunding({
      positions: unpriced,
      bilQuoted: false,
      chain,
      expiry,
      events: skipped,
      logs,
    });
    expect(skipped.filter((e) => e.startsWith("fund:"))).toEqual([]);
    expect(still.verticals.map((v) => v.symbol)).toEqual(["HYG", "LQD", "JNK"]);
    expect(still.bought.map((b) => b.symbol)).toEqual(["TLT"]);
    expect(logs.some((l) => /skip/i.test(l) && /cash|BIL/i.test(l))).toBe(false);
  });
});

function leg(underlying: string, strike: number, bid: number, ask: number): OptionLeg {
  return {
    underlying,
    osiKey: `O:${underlying}261009P${String(Math.round(strike * 1000)).padStart(8, "0")}`,
    displaySymbol: `${underlying} P ${strike}`,
    right: "P",
    strike,
    expiry: "2026-10-09",
    bid,
    ask,
    last: (bid + ask) / 2,
    bidSize: 500,
    askSize: 500,
    openInterest: 500,
    delta: -0.4,
    gamma: 0.01,
    theta: -0.02,
    vega: 0.1,
    iv: 0.2,
  };
}

async function runBreakFunding(input: {
  positions: Position[];
  bilQuoted: boolean;
  chain: (symbol: string, atm: number) => OptionLeg[];
  expiry: Array<{ year: number; month: number; day: number; expiry: string; expiryType: "MONTHLY" }>;
  events: string[];
  logs?: string[];
}) {
  const quotes = [
    { symbol: "FTLS", last: 100 },
    { symbol: "TLT", last: 100 },
    { symbol: "HYG", last: 79 },
    { symbol: "LQD", last: 108 },
    { symbol: "JNK", last: 76 },
    ...(input.bilQuoted ? [{ symbol: "BIL", last: 100 }] : []),
  ];
  return runAutopilot({
    enabled: true,
    sleeveAuto: {
      day: false,
      momentum: false,
      ownership: false,
      options: false,
      riskoff: true,
    },
    getPositions: () => input.positions,
    getSleeves: () => defaultSleeves(),
    momentumRows: [],
    featureRows: [],
    scanReady: true,
    riskOn: false,
    riskChecks: {
      spyAbove200: false,
      hygAbove200: false,
      lqdAbove200: false,
      jnkAbove200: false,
      dollarVeto: false,
    },
    riskoffQuotes: quotes,
    riskoffEtfQuotes: quotes,
    now: MIDDAY,
    place: async (b) => {
      input.events.push(`buy:${b.symbol}`);
      return { ok: true };
    },
    close: async (s) => {
      if (s.cashSweep && s.reason === "sell cash sweep to fund entry") {
        input.events.push(`fund:${s.qty ?? 0}`);
        const sweep = input.positions.find((p) => p.cashSweep);
        if (sweep && s.qty) sweep.qty -= s.qty;
      } else {
        input.events.push(`close:${s.symbol}`);
      }
      return { ok: true };
    },
    placeVertical: async (v) => {
      input.events.push(`put:${v.symbol}`);
      const debit = 0.23;
      const qty = v.qty ?? 1;
      input.positions.push(putDebit(debit));
      const booked = input.positions[input.positions.length - 1];
      booked.qty = qty;
      booked.symbol = `${v.symbol}-put`;
      return { ok: true };
    },
    fetchExpiries: async () => input.expiry,
    fetchChain: async (symbol: string) => {
      if (symbol === "HYG") return input.chain("HYG", 79);
      if (symbol === "LQD") return input.chain("LQD", 108);
      if (symbol === "JNK") return input.chain("JNK", 76);
      return input.chain(symbol, 100);
    },
    log: (line) => input.logs?.push(line),
  });
}

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
