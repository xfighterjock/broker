import { describe, expect, it } from "vitest";
import { cashSessionCloseMinute } from "../shared/marketSession";
import type { Position } from "../shared/types";
import { isHighBeta } from "../server/src/cspMath";
import { cspOpenUnderlyings, runCspDecisions } from "../server/src/cspCycle";
import { collectEntryCandidates } from "../server/src/cspLive";
import { parseCspState } from "../server/src/cspStore";
import {
  cspQueueDropLine,
  monthEndBeta,
  monthEndBetaSpec,
  revalidateQueuedSignals,
  selectCspSignals,
  type CspDailyBar,
  type CspPendingSignal,
} from "../server/src/cspScan";

function bar(ymd: string, close: number): CspDailyBar {
  return { ymd, high: close + 1, low: close - 1, close, volume: 1_000 };
}

function tradingDays(from: string, to: string): string[] {
  const out: string[] = [];
  let cursor = from;
  while (cursor <= to) {
    const [y, m, d] = cursor.split("-").map(Number);
    if (cashSessionCloseMinute(y, m, d) !== null) out.push(cursor);
    const next = new Date(Date.UTC(y, m - 1, d + 1));
    cursor = next.toISOString().slice(0, 10);
  }
  return out;
}

/** Stock daily return is `k` times the SPY return. `k` switches after `splitYmd`. */
function scaledPair(kBefore: number, kAfter: number, splitYmd: string) {
  const days = tradingDays("2024-01-02", "2025-10-31");
  let spyPx = 100;
  let stockPx = 100;
  const spy: CspDailyBar[] = [];
  const stock: CspDailyBar[] = [];
  days.forEach((ymd, i) => {
    let ret = ((i % 7) - 3) * 0.001;
    if (ret === 0) ret = 0.0005;
    spyPx *= 1 + ret;
    const k = ymd <= splitYmd ? kBefore : kAfter;
    stockPx *= 1 + k * ret;
    spy.push(bar(ymd, spyPx));
    stock.push(bar(ymd, stockPx));
  });
  return { spy, stock };
}

function pending(symbol: string, beta: number): CspPendingSignal {
  return {
    symbol,
    signalYmd: "2026-10-16",
    tradeYmd: "2026-10-19",
    swingLow: 100,
    earnings: [],
    beta,
  };
}

function put(underlying: string): Position {
  return {
    id: `p-${underlying}`,
    symbol: `${underlying} 2026-11-20 100P`,
    root: null,
    qty: 1,
    side: "Short",
    avgPrice: 2,
    unrealizedPnl: 0,
    gated: false,
    sleeveId: "csp",
    csp: {
      underlying,
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
}

function assigned(symbol: string): Position {
  return {
    id: `a-${symbol}`,
    symbol,
    root: null,
    qty: 100,
    side: "Long",
    avgPrice: 100,
    unrealizedPnl: 0,
    gated: false,
    sleeveId: "csp",
    cspAssigned: { fromPositionId: "old", strike: 100, expiry: "2026-10-16" },
  };
}

function candidate(underlying: string) {
  return {
    underlying,
    expiry: "2026-11-20",
    strike: 100,
    bid: 2.4,
    ask: 2.6,
    iv: 0.35,
    delta: -0.2,
    oi: 500,
    volume: 40,
    signalOk: true,
    earningsOk: true,
  };
}

describe("csp month-end beta", () => {
  it("uses the prior month's last trading day for the whole following month", () => {
    expect(monthEndBetaSpec(new Date("2025-10-16T14:00:00Z"))).toEqual({
      appliesTo: "2025-10",
      asOfYmd: "2025-09-30",
    });
    expect(monthEndBetaSpec(new Date("2025-10-31T20:12:00Z"))).toEqual({
      appliesTo: "2025-10",
      asOfYmd: "2025-09-30",
    });
    expect(monthEndBetaSpec(new Date("2025-11-01T14:00:00Z"))).toEqual({
      appliesTo: "2025-11",
      asOfYmd: "2025-10-31",
    });
    expect(monthEndBetaSpec(new Date("2026-10-16T20:12:00Z")).asOfYmd).toBe("2026-09-30");
    expect(monthEndBetaSpec(new Date("2026-11-01T15:00:00Z"))).toEqual({
      appliesTo: "2026-11",
      asOfYmd: "2026-10-30",
    });
  });

  it("keeps September's beta through October and switches on November 1", () => {
    const { spy, stock } = scaledPair(1.2, 4, "2025-09-30");
    const sep = monthEndBeta(stock, spy, "2025-09-30");
    const oct = monthEndBeta(stock, spy, "2025-10-31");
    expect(sep).not.toBeNull();
    expect(oct).not.toBeNull();
    expect(sep!).toBeLessThan(1.3);
    expect(oct!).toBeGreaterThan(1.3);
    expect(oct).not.toBeCloseTo(sep!);

    const names = [{ symbol: "HOT", bars: stock }];
    const oct16 = selectCspSignals({
      names,
      spy,
      earningsBySymbol: new Map(),
      now: new Date("2025-10-16T14:00:00Z"),
    });
    const oct31 = selectCspSignals({
      names,
      spy,
      earningsBySymbol: new Map(),
      now: new Date("2025-10-31T20:12:00Z"),
    });
    const nov1 = selectCspSignals({
      names,
      spy,
      earningsBySymbol: new Map(),
      now: new Date("2025-11-01T14:00:00Z"),
    });
    expect(oct16.ranked[0]).toMatchObject({ symbol: "HOT", asOfYmd: "2025-09-30" });
    expect(oct31.ranked[0].asOfYmd).toBe("2025-09-30");
    expect(oct31.ranked[0].beta).toBeCloseTo(oct16.ranked[0].beta);
    expect(nov1.ranked[0]).toMatchObject({ symbol: "HOT", asOfYmd: "2025-10-31" });
    expect(nov1.ranked[0].beta).toBeGreaterThan(1.3);
    expect(nov1.ranked[0].beta).not.toBeCloseTo(oct16.ranked[0].beta);

    const frozen = selectCspSignals({
      names,
      spy,
      earningsBySymbol: new Map(),
      now: new Date("2025-10-20T14:00:00Z"),
      cachedBetas: new Map([["HOT", 1.05]]),
    });
    expect(frozen.ranked[0].beta).toBe(1.05);
    expect(frozen.ranked[0].asOfYmd).toBe("2025-09-30");
    expect(frozen.pending).toHaveLength(0);
  });

  it("requires beta strictly above 1.3", () => {
    const below = scaledPair(1.28, 1.28, "2025-10-31");
    const above = scaledPair(1.31, 1.31, "2025-10-31");
    const low = monthEndBeta(below.stock, below.spy, "2025-09-30");
    const high = monthEndBeta(above.stock, above.spy, "2025-09-30");
    expect(low).not.toBeNull();
    expect(high).not.toBeNull();
    expect(isHighBeta(low)).toBe(false);
    expect(isHighBeta(high)).toBe(true);
    expect(isHighBeta(1.3)).toBe(false);
    expect(isHighBeta(1.28)).toBe(false);
    expect(isHighBeta(1.31)).toBe(true);
    const edge = revalidateQueuedSignals({
      pending: [pending("FLAT", 1.3), pending("OVER", 1.31)],
      betaBySymbol: new Map<string, number | null>([
        ["FLAT", 1.3],
        ["OVER", 1.31],
      ]),
      openUnderlyings: new Set(),
      asOfYmd: "2026-09-30",
    });
    expect(edge.dropped).toEqual([{ symbol: "FLAT", reason: "beta below 1.3 at month end" }]);
    expect(edge.pending.map((p) => p.symbol)).toEqual(["OVER"]);
  });

  it("drops a queued signal whose month-end beta is not above 1.3 and one that is already open", () => {
    const checked = revalidateQueuedSignals({
      pending: [
        pending("CRH", 1.9),
        pending("OPEN", 1.8),
        pending("KEEP", 0.4),
        pending("EDGE", 2),
        pending("KEEP", 1.31),
        pending("MISS", 1.7),
      ],
      betaBySymbol: new Map<string, number | null>([
        ["CRH", 1.28],
        ["OPEN", 1.8],
        ["KEEP", 1.31],
        ["EDGE", 1.3],
      ]),
      openUnderlyings: new Set(["OPEN"]),
      asOfYmd: "2026-09-30",
    });
    expect(checked.dropped).toEqual([
      { symbol: "CRH", reason: "beta below 1.3 at month end" },
      { symbol: "OPEN", reason: "already open" },
      { symbol: "EDGE", reason: "beta below 1.3 at month end" },
      { symbol: "KEEP", reason: "already open" },
      { symbol: "MISS", reason: "beta below 1.3 at month end" },
    ]);
    expect(checked.pending).toHaveLength(1);
    expect(checked.pending[0]).toMatchObject({ symbol: "KEEP", beta: 1.31, betaAsOfYmd: "2026-09-30" });
    expect(cspQueueDropLine("CRH", "beta below 1.3 at month end")).toBe(
      "[EventGate] csp queue drop CRH: beta below 1.3 at month end",
    );
  });

  it("does not trust a pre-rule rank cache that has no month-end as-of", () => {
    const parsed = parseCspState(
      JSON.stringify({
        scannedAt: "2026-10-16T20:12:00.000Z",
        pending: [pending("CRH", 1.42)],
        ranked: [{ symbol: "CRH", beta: 1.42 }],
      }),
    );
    expect(parsed.betaMonth).toBeNull();
    expect(parsed.betaAsOfYmd).toBeNull();
    expect(parsed.ranked[0].asOfYmd).toBeUndefined();
    expect(parsed.pending[0]).toMatchObject({ symbol: "CRH", tradeYmd: "2026-10-19", beta: 1.42 });
  });
});

describe("csp one open put per name", () => {
  const now = new Date("2026-10-16T14:00:00Z");

  function decide(positions: Position[], names: string[]) {
    return runCspDecisions({
      now,
      riskOn: false,
      autoOn: true,
      gateEnabled: true,
      gateMode: "idle",
      lossCapHit: false,
      equityUsd: 100_000,
      positions,
      candidates: names.map(candidate),
      chainAvailable: true,
      atClose: false,
      marks: {},
      shadows: [],
    });
  }

  it("skips an underlying that already has a csp put or assigned shares", () => {
    const openPut = decide([put("NVDA")], ["NVDA"]);
    expect(openPut.orders.filter((o) => o.kind === "sell-put")).toHaveLength(0);
    expect(openPut.skips).toEqual([{ symbol: "NVDA", reason: "already open" }]);

    const shares = decide([assigned("NVDA")], ["NVDA"]);
    expect(shares.orders.filter((o) => o.kind === "sell-put")).toHaveLength(0);
    expect(shares.skips).toEqual([{ symbol: "NVDA", reason: "already open" }]);

    const overlay: Position = { ...put("NVDA"), id: "overlay", sleeveId: "options" };
    const otherSleeve = decide([overlay], ["NVDA"]);
    expect(otherSleeve.orders.filter((o) => o.kind === "sell-put")).toHaveLength(1);
    expect(cspOpenUnderlyings([overlay]).size).toBe(0);

    const pair = decide([], ["AMD", "AMD"]);
    expect(pair.orders.filter((o) => o.kind === "sell-put")).toHaveLength(1);
    expect(pair.skips).toEqual([{ symbol: "AMD", reason: "already open" }]);
  });

  it("skips the chain when the name is already open", async () => {
    let chains = 0;
    const built = await collectEntryCandidates({
      now,
      pending: [{ ...pending("NVDA", 1.8), tradeYmd: "2026-10-16" }],
      openUnderlyings: new Set(["nvda"]),
      rate: 0.04,
      authOk: true,
      spot: async () => 120,
      expiries: async () => ({ ok: true, dates: ["2026-12-01"] }),
      chain: async () => {
        chains += 1;
        return { ok: true, legs: [] };
      },
    });
    expect(built.candidates).toHaveLength(0);
    expect(built.skips).toEqual([{ symbol: "NVDA", reason: "already open" }]);
    expect(chains).toBe(0);
  });
});
