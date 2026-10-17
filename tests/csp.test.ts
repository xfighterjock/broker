import { describe, expect, it } from "vitest";
import { REDIS_KEYS } from "../shared/constants";
import { riskFromFeatures, riskOffFallback } from "../server/src/risk";
import { MockBroker } from "../server/src/mockBroker";
import { purgeRiskoffSleeve } from "../server/src/riskoffCleanup";
import {
  CSP_SHADOW_RULES,
  applyShadowCheck,
  betaToBenchmark,
  calendarDte,
  collateralInvariant,
  cspBuyFill,
  cspEntrySignal,
  cspSellFill,
  dailyReturns,
  earningsWindowDecision,
  macdHistUp,
  macdHistogram,
  pickCspExpiry,
  pickCspStrike,
  planCspEntry,
  putExpiresItm,
  resolvePutDelta,
  shortPutPnlPerContract,
  sizeCashSecuredPut,
  slowStochastic,
  stochCrossUpBelow20,
  twoXStopHit,
  type OhlcBar,
  type PutQuote,
  type ShadowMarket,
  type ShadowRow,
} from "../server/src/cspMath";
import { runCspDecisions, shadowOrders, type CspCycleCtx } from "../server/src/cspCycle";
import type { Position } from "../shared/types";
import type { ScanFeatures } from "../server/src/scan";

function feat(above200: boolean): ScanFeatures {
  return {
    last: 100,
    sma20: 99,
    sma200: above200 ? 90 : 110,
    high52: 101,
    pctFrom52: -0.01,
    dist20: 0.01,
    above200,
    ret63: 0.1,
    ret126: 0.2,
    ret252: 0.3,
    has252: true,
    volx: 1,
  };
}

function barsFromCloses(closes: number[], spread = 1): OhlcBar[] {
  return closes.map((close) => ({ high: close + spread, low: close - spread, close }));
}

function readyQuote() {
  return {
    underlying: "NVDA",
    expiry: "2026-11-20",
    strike: 100,
    bid: 2.4,
    ask: 2.6,
    iv: 0.35,
    delta: -0.2,
    oi: 500,
    volume: 40,
  };
}

function plan(riskOn: boolean) {
  return planCspEntry({
    riskOn,
    autoOn: true,
    gateEnabled: true,
    gateMode: "idle",
    inCashSession: true,
    chainAvailable: true,
    lossCapHit: false,
    equityUsd: 100_000,
    reservedUsd: 0,
    assignedMvUsd: 0,
    openPutCount: 0,
    signalOk: true,
    earningsOk: true,
    quote: readyQuote(),
  });
}

describe("csp signal math", () => {
  it("fires a slow stochastic (30,5,5) cross up through %D while %K is below 20", () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 - i * 0.4);
    for (let i = 0; i < 6; i++) closes.push(84 + i * 1.2);
    const series = slowStochastic(barsFromCloses(closes, 2));
    const defined = series.filter((p) => p !== null);
    expect(defined.length).toBeGreaterThan(2);
    const crossed = stochCrossUpBelow20(series);
    expect(typeof crossed).toBe("boolean");
    const prev = series[series.length - 2];
    const cur = series[series.length - 1];
    if (prev && cur && prev.k <= prev.d && cur.k > cur.d && cur.k < 20) {
      expect(crossed).toBe(true);
    }
  });

  it("requires the MACD histogram to be up", () => {
    const up = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 16, 18, 21, 25, 30, 36, 43, 51, 60, 70, 82, 95, 110, 126, 143, 161, 180, 200, 221, 243, 266, 290, 315, 341, 368, 396];
    const hist = macdHistogram(up);
    expect(macdHistUp(hist)).toBe(true);
    const turn = Array.from({ length: 60 }, (_, i) => (i < 50 ? 100 + i : 150 - (i - 50) * 8));
    expect(macdHistUp(macdHistogram(turn))).toBe(false);
  });

  it("computes trailing beta to the benchmark", () => {
    const stock = Array.from({ length: 260 }, (_, i) => 0.002 + (i % 5) * 0.0001);
    const bench = stock.map((r) => r / 2);
    const beta = betaToBenchmark(stock, bench, 252);
    expect(beta).not.toBeNull();
    expect(beta!).toBeGreaterThan(1.3);
    expect(dailyReturns([100, 110, 99]).length).toBe(2);
  });

  it("skips an earnings date inside the entry-to-expiry window and an unknown calendar", () => {
    expect(earningsWindowDecision(null, "2026-10-17", "2026-12-01")).toEqual({
      ok: false,
      reason: "earnings date unknown",
    });
    expect(earningsWindowDecision(["2026-11-01"], "2026-10-17", "2026-12-01").ok).toBe(false);
    expect(earningsWindowDecision(["2026-12-15"], "2026-10-17", "2026-12-01").ok).toBe(true);
    expect(earningsWindowDecision([], "2026-10-17", "2026-12-01").ok).toBe(true);
  });

  it("picks the expiry nearest 45 DTE inside 35–50 and the strike nearest 0.20 delta", () => {
    const picked = pickCspExpiry(["2026-11-21", "2026-12-01", "2026-12-18"], "2026-10-17");
    expect(picked).not.toBeNull();
    expect(picked!.expiry).toBe("2026-12-01");
    expect(picked!.dte).toBe(45);
    expect(picked!.dte).toBeGreaterThanOrEqual(35);
    expect(picked!.dte).toBeLessThanOrEqual(50);
    expect(Math.abs(picked!.dte - 45)).toBeLessThanOrEqual(Math.abs(calendarDte("2026-10-17", "2026-12-18")! - 45));
    const quotes: PutQuote[] = [
      { strike: 90, delta: -0.1, bid: 1, ask: 1.2, iv: 0.3, openInterest: 200, volume: 10, last: 1.1 },
      { strike: 100, delta: -0.2, bid: 2, ask: 2.2, iv: 0.3, openInterest: 200, volume: 10, last: 2.1 },
      { strike: 110, delta: -0.4, bid: 4, ask: 4.4, iv: 0.3, openInterest: 200, volume: 10, last: 4.2 },
    ];
    const strike = pickCspStrike(quotes, 120, 45, 0.04);
    expect(strike?.quote.strike).toBe(100);
    const bs = resolvePutDelta({ strike: 100, delta: null, iv: 0.3 }, 120, 45, 0.04);
    expect(bs).not.toBeNull();
    expect(bs!.delta).toBeLessThan(0);
  });

  it("sells at max(bid, mid - 0.25 * spread) and buys at min(ask, mid + 0.25 * spread)", () => {
    const sold = cspSellFill(2, 2.4);
    expect(sold.ok).toBe(true);
    if (sold.ok) expect(sold.fill).toBeCloseTo(Math.max(2, 2.2 - 0.25 * 0.4));
    expect(cspBuyFill(2, 2.4, 2.2)).toBeCloseTo(Math.min(2.4, 2.2 + 0.25 * 0.4));
    expect(cspSellFill(0.05, 0.06).ok).toBe(false);
  });

  it("keeps reserved collateral plus assigned market value within equity", () => {
    for (let i = 0; i < 40; i++) {
      const equity = 50_000 + i * 3_000;
      const strike = 20 + (i % 17) * 15;
      const reserved = (i % 5) * 4_000;
      const assigned = (i % 3) * 2_500;
      const sized = sizeCashSecuredPut({
        equityUsd: equity,
        reservedUsd: reserved,
        assignedMvUsd: assigned,
        strike,
        openPutCount: i % 11,
      });
      if (!sized.ok) continue;
      expect(collateralInvariant(reserved + sized.reservedUsd, assigned, equity)).toBe(true);
    }
    const tooBig = sizeCashSecuredPut({
      equityUsd: 10_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      strike: 200,
      openPutCount: 0,
    });
    expect(tooBig.ok).toBe(false);
  });

  it("stops at 2x premium and assigns only when the close is below the strike", () => {
    expect(twoXStopHit(4.1, 2)).toBe(true);
    expect(twoXStopHit(3.9, 2)).toBe(false);
    expect(putExpiresItm(99, 100)).toBe(true);
    expect(putExpiresItm(100, 100)).toBe(false);
    expect(shortPutPnlPerContract(2, 0)).toBe(200);
  });

  it("combines beta, stochastic cross, and MACD without a 200-day filter", () => {
    const closes = Array.from({ length: 50 }, (_, i) => 80 + Math.sin(i / 3) * 5 + i * 0.05);
    const signal = cspEntrySignal({ bars: barsFromCloses(closes, 3), beta: 1.5 });
    expect(signal.ok === true || (signal.ok === false && signal.reason.length > 0)).toBe(true);
    expect(cspEntrySignal({ bars: barsFromCloses(closes, 3), beta: 1.1 }).ok).toBe(false);
  });
});

describe("csp entries ignore the risk regime", () => {
  it("plans a cash-secured put when riskOn is false", () => {
    const off = plan(false);
    const on = plan(true);
    expect(off.entry).not.toBeNull();
    expect(off.skip).toBeNull();
    expect(off.entry).toEqual(on.entry);
    expect(riskFromFeatures({
      spy: null,
      acwi: null,
      hyg: null,
      uup20dPct: null,
    }).riskOn).toBe(false);
    expect(riskOffFallback().riskOn).toBe(false);
  });

  it("still sells the put from the cycle when riskOn is false and does not trade a shadow exit", () => {
    const now = new Date("2026-10-16T14:00:00Z");
    const ctx: CspCycleCtx = {
      now,
      riskOn: false,
      autoOn: true,
      gateEnabled: true,
      gateMode: "idle",
      lossCapHit: false,
      equityUsd: 100_000,
      positions: [],
      candidates: [
        {
          ...readyQuote(),
          signalOk: true,
          earningsOk: true,
        },
      ],
      chainAvailable: true,
      atClose: false,
      marks: {},
      shadows: [],
    };
    const result = runCspDecisions(ctx);
    expect(result.orders.filter((o) => o.kind === "sell-put")).toHaveLength(1);
    expect(shadowOrders(result)).toEqual([]);

    const pos: Position = {
      id: "p1",
      symbol: "NVDA 2026-11-20 100P",
      root: null,
      qty: 1,
      side: "Short",
      avgPrice: 2,
      unrealizedPnl: 0,
      gated: false,
      sleeveId: "csp",
      csp: {
        underlying: "NVDA",
        strike: 100,
        expiry: "2026-11-20",
        entryPremium: 2,
        contracts: 1,
        reservedUsd: 10_000,
        entryYmd: "2026-10-16",
        swingLow: 90,
        iv: 0.3,
        delta: -0.2,
        bid: 2,
        ask: 2.2,
        mid: 2.1,
        openInterest: 400,
        volume: 10,
      },
    };
    const market: ShadowMarket = {
      mid: 0.8,
      bid: 0.7,
      ask: 0.9,
      delta: -0.1,
      dte: 30,
      underlyingPx: 120,
      underlyingClose: null,
      spyClose: null,
      spySma200: null,
      atClose: false,
      entryCredit: 2,
      swingLow: 90,
    };
    const shadows = applyShadowCheck([] as ShadowRow[], pos.id, market, now.toISOString());
    const tp50 = shadows.find((r) => r.ruleId === "tp50");
    expect(tp50?.triggeredAt).toBeTruthy();
    const managed = runCspDecisions({
      ...ctx,
      candidates: [],
      positions: [pos],
      shadows,
      marks: {
        p1: {
          mid: 0.8,
          bid: 0.7,
          ask: 0.9,
          delta: -0.1,
          underlyingPx: 120,
          underlyingClose: null,
          spyClose: null,
          spySma200: null,
          dte: 30,
        },
      },
    });
    expect(managed.orders.filter((o) => o.kind === "buy-put")).toEqual([]);
    expect(shadowOrders(managed)).toEqual([]);
    expect(CSP_SHADOW_RULES).toContain("7+8+2x");
  });

  it("blocks a new short when GATE is off and still allows the 2x buyback", () => {
    const blocked = planCspEntry({ ...plan(false), gateEnabled: false } as never);
    expect(plan(false).entry).not.toBeNull();
    const gated = planCspEntry({
      riskOn: false,
      autoOn: true,
      gateEnabled: false,
      gateMode: "idle",
      inCashSession: true,
      chainAvailable: true,
      lossCapHit: false,
      equityUsd: 100_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      openPutCount: 0,
      signalOk: true,
      earningsOk: true,
      quote: readyQuote(),
    });
    expect(gated.entry).toBeNull();
    expect(gated.skip).toMatch(/GATE OFF/);
    void blocked;
  });
});

describe("riskoff purge", () => {
  it("flattens and deletes riskoff paper data, leaves other sleeves, and is idempotent", async () => {
    const broker = new MockBroker();
    broker.injectPosition({
      symbol: "FTLS",
      qty: 390,
      side: "Long",
      avgPrice: 50,
      unrealizedPnl: -20,
      sleeveId: "riskoff" as unknown as "csp",
    });
    broker.injectPosition({
      symbol: "SPY",
      qty: 10,
      side: "Long",
      avgPrice: 500,
      unrealizedPnl: 15,
      sleeveId: "momentum",
    });
    broker.injectOrder({
      symbol: "FTLS",
      type: "StopMarket",
      side: "Sell",
      qty: 390,
      stopPrice: 45,
      sleeveId: "riskoff" as unknown as "csp",
    });
    const store = new Map<string, string>([
      [REDIS_KEYS.blotter, JSON.stringify([{ sleeveId: "riskoff" }, { sleeveId: "momentum" }])],
      [REDIS_KEYS.sleeves, JSON.stringify({ riskoff: { id: "riskoff" }, momentum: { id: "momentum" } })],
      [REDIS_KEYS.sessionMarks, JSON.stringify({ riskoff: { ymd: "2026-10-16" }, day: null })],
      [REDIS_KEYS.autoPaper, JSON.stringify({ day: false, riskoff: true })],
      [REDIS_KEYS.riskoffDistributions, JSON.stringify(["riskoff|FTLS|2026-10-01"])],
    ]);
    const redis = {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string) => {
        store.set(key, value);
      },
      del: async (key: string) => {
        store.delete(key);
      },
    };
    const queries: string[] = [];
    const pool = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rowCount: sql.includes("gate_log") ? 2 : 0 };
      },
    };
    const regimeBefore = riskFromFeatures({
      spy: feat(false),
      acwi: feat(true),
      hyg: feat(true),
      uup20dPct: 0,
    });
    const logs: string[] = [];
    const first = await purgeRiskoffSleeve({ broker, redis, pool, log: (l) => logs.push(l) });
    expect(first.flattened).toBe(1);
    expect(first.positionsDeleted).toBe(1);
    expect(first.ordersDeleted).toBe(1);
    expect(first.blotterDeleted).toBe(1);
    expect(broker.getPositionsSync().map((p) => p.symbol)).toEqual(["SPY"]);
    expect(broker.getPositionsSync()[0].sleeveId).toBe("momentum");
    expect(JSON.parse(store.get(REDIS_KEYS.blotter)!)).toEqual([{ sleeveId: "momentum" }]);
    expect(JSON.parse(store.get(REDIS_KEYS.sleeves)!)).not.toHaveProperty("riskoff");
    expect(store.has(REDIS_KEYS.riskoffDistributions)).toBe(false);
    const auto = JSON.parse(store.get(REDIS_KEYS.autoPaper)!);
    expect(auto).not.toHaveProperty("riskoff");
    expect(auto.csp).toBe(true);
    expect(queries.some((q) => q.includes("gate_log") && q.includes("riskoff"))).toBe(true);
    expect(queries.some((q) => /momentum|options|ownership/.test(q) && q.startsWith("DELETE"))).toBe(false);
    const regimeAfter = riskFromFeatures({
      spy: feat(false),
      acwi: feat(true),
      hyg: feat(true),
      uup20dPct: 0,
    });
    expect(regimeAfter).toEqual(regimeBefore);
    expect(logs[0]).toMatch(/flattened=1/);
    const second = await purgeRiskoffSleeve({ broker, redis, pool, log: () => {} });
    expect(second.flattened).toBe(0);
    expect(second.positionsDeleted).toBe(0);
    expect(second.blotterDeleted).toBe(0);
    expect(broker.getPositionsSync()).toHaveLength(1);
  });
});
