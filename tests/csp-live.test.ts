import { describe, expect, it } from "vitest";
import type { OptionLeg } from "../shared/types";
import { summarizeShadowExits, type ShadowRow } from "../server/src/cspMath";
import { cspRecorderSlot, runCspDecisions } from "../server/src/cspCycle";
import { parseMassiveOhlcDailyBars } from "../server/src/massive";
import { collectEntryCandidates } from "../server/src/cspLive";
import {
  annualRateFromIrx,
  completedDailyBars,
  cspCloseScanWindow,
  cspScanDue,
  cspTradeYmd,
  pairedBeta,
  parseYahooEarningsCalendar,
  parseYahooOhlcDailyBars,
  recorderSymbols,
  selectCspSignals,
  type CspDailyBar,
} from "../server/src/cspScan";

function bar(ymd: string, close: number, span = 1): CspDailyBar {
  return { ymd, high: close + span, low: close - span, close, volume: 1_000 };
}

function series(start: string, closes: number[]): CspDailyBar[] {
  const [y, m, d] = start.split("-").map(Number);
  return closes.map((close, i) => {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    const ymd = dt.toISOString().slice(0, 10);
    return bar(ymd, close);
  });
}

function putLeg(expiry: string, strike: number, delta: number): OptionLeg {
  return {
    underlying: "NVDA",
    osiKey: `NVDA${expiry}${strike}`,
    displaySymbol: "NVDA",
    right: "P",
    strike,
    expiry,
    bid: 2,
    ask: 2.2,
    last: 2.1,
    bidSize: 10,
    askSize: 10,
    openInterest: 400,
    delta,
    gamma: 0.01,
    theta: -0.02,
    vega: 0.1,
    iv: 0.3,
  };
}

describe("csp live scan", () => {
  it("scans in the 16:10 ET window and again when the cache is stale", () => {
    const morning = new Date("2026-10-16T14:00:00Z");
    const close = new Date("2026-10-16T20:12:00Z");
    expect(cspCloseScanWindow(morning)).toBe(false);
    expect(cspCloseScanWindow(close)).toBe(true);
    expect(cspScanDue(null, null, morning)).toBe(true);
    expect(cspScanDue(morning.toISOString(), "2026-10-15", close)).toBe(true);
    expect(cspScanDue(close.toISOString(), "2026-10-16", close)).toBe(false);
    const fresh = new Date(morning.getTime() - 2 * 60 * 60 * 1000).toISOString();
    expect(cspScanDue(fresh, "2026-10-15", morning)).toBe(false);
    const old = new Date(morning.getTime() - 30 * 60 * 60 * 1000).toISOString();
    expect(cspScanDue(old, "2026-10-15", morning)).toBe(true);
    expect(cspTradeYmd(morning)).toBe("2026-10-16");
    expect(cspTradeYmd(close)).toBe("2026-10-19");
    expect(cspRecorderSlot(new Date("2026-10-16T16:30:00Z"))).toBe("mid");
    expect(cspRecorderSlot(new Date("2026-10-16T20:16:00Z"))).toBe("close");
    expect(cspRecorderSlot(new Date("2026-10-17T16:30:00Z"))).toBeNull();
  });

  it("drops an incomplete session bar and keeps the official close", () => {
    const bars = [bar("2026-10-15", 100), bar("2026-10-16", 101)];
    expect(completedDailyBars(bars, new Date("2026-10-16T14:00:00Z")).map((b) => b.ymd)).toEqual(["2026-10-15"]);
    expect(completedDailyBars(bars, new Date("2026-10-16T20:12:00Z")).map((b) => b.ymd)).toEqual([
      "2026-10-15",
      "2026-10-16",
    ]);
  });

  it("ranks beta to SPY and only queues a high-beta signal", () => {
    const spyCloses = Array.from({ length: 280 }, (_, i) => 100 * (1 + ((i % 5) - 2) * 0.002));
    const hot = spyCloses.map((c, i) => c * (1 + ((i % 5) - 2) * 0.004));
    const cold = spyCloses.map((c) => c);
    const spy = series("2025-01-02", spyCloses);
    const names = [
      { symbol: "HOT", bars: series("2025-01-02", hot) },
      { symbol: "COLD", bars: series("2025-01-02", cold) },
    ];
    expect(pairedBeta(names[0].bars, spy)).toBeGreaterThan(1.3);
    expect(pairedBeta(names[1].bars, spy)).toBeLessThan(1.3);
    const selected = selectCspSignals({
      names,
      spy,
      earningsBySymbol: new Map([["HOT", []]]),
      now: new Date("2026-10-16T20:12:00Z"),
    });
    expect(selected.ranked[0].symbol).toBe("HOT");
    expect(selected.ranked[0].asOfYmd).toBe("2026-09-30");
    expect(selected.pending.every((p) => p.symbol !== "COLD")).toBe(true);
    expect(selected.pending.every((p) => p.beta > 1.3 && p.betaAsOfYmd === "2026-09-30")).toBe(true);
  });

  it("parses Massive and Yahoo daily OHLC and an earnings calendar", () => {
    const massive = parseMassiveOhlcDailyBars({
      results: [{ t: Date.parse("2026-10-15T00:00:00Z"), h: 11, l: 9, c: 10, v: 5 }],
    });
    expect(massive).toEqual([{ ymd: "2026-10-15", high: 11, low: 9, close: 10, volume: 5 }]);
    const yahoo = parseYahooOhlcDailyBars({
      chart: {
        result: [
          {
            timestamp: [Date.parse("2026-10-15T00:00:00Z") / 1000],
            indicators: { quote: [{ high: [11], low: [9], close: [10], volume: [5] }] },
          },
        ],
      },
    });
    expect(yahoo?.[0].close).toBe(10);
    expect(parseYahooEarningsCalendar({ quoteSummary: { result: [{ calendarEvents: { earnings: {} } }] } })).toBeNull();
    expect(
      parseYahooEarningsCalendar({
        quoteSummary: { result: [{ calendarEvents: { earnings: { earningsDate: [] } } }] },
      }),
    ).toEqual([]);
    expect(annualRateFromIrx(4.2)).toBeCloseTo(0.042);
    expect(annualRateFromIrx(null)).toBe(0.04);
  });

  it("builds a next-session candidate from an E*TRADE chain with no riskOn input", async () => {
    const now = new Date("2026-10-16T14:00:00Z");
    const built = await collectEntryCandidates({
      now,
      pending: [
        {
          symbol: "NVDA",
          signalYmd: "2026-10-15",
          tradeYmd: "2026-10-16",
          swingLow: 90,
          earnings: [],
          beta: 1.8,
        },
      ],
      openUnderlyings: new Set(),
      rate: 0.04,
      authOk: true,
      spot: async () => 120,
      expiries: async () => ({ ok: true, dates: ["2026-12-01", "2026-10-30"] }),
      chain: async () => ({
        ok: true,
        legs: [putLeg("2026-12-01", 90, -0.1), putLeg("2026-12-01", 100, -0.2), putLeg("2026-12-01", 110, -0.45)],
      }),
    });
    expect(built.blocking).toBe(false);
    expect(built.candidates).toHaveLength(1);
    expect(built.candidates[0]).toMatchObject({ underlying: "NVDA", strike: 100, expiry: "2026-12-01", earningsOk: true });
    const sold = runCspDecisions({
      now,
      riskOn: false,
      autoOn: true,
      gateEnabled: true,
      gateMode: "idle",
      lossCapHit: false,
      equityUsd: 100_000,
      positions: [],
      candidates: built.candidates,
      chainAvailable: true,
      atClose: false,
      marks: {},
      shadows: [],
    });
    expect(sold.orders.filter((o) => o.kind === "sell-put")).toHaveLength(1);
  });

  it("records candidates, open names, and the top beta names without duplicates", () => {
    const ranked = Array.from({ length: 60 }, (_, i) => ({ symbol: `S${i}`, beta: 3 - i * 0.01 }));
    const symbols = recorderSymbols(["NVDA", "S0"], ["NVDA"], ranked, 50);
    expect(symbols[0]).toBe("NVDA");
    expect(symbols.filter((s) => s === "NVDA")).toHaveLength(1);
    expect(symbols).toContain("S0");
    expect(symbols.length).toBeLessThanOrEqual(52);
    expect(symbols).not.toContain("S59");
  });

  it("summarizes a triggered shadow before the live put closes", () => {
    const row: ShadowRow = {
      positionId: "p1",
      ruleId: "tp50",
      triggeredAt: "2026-10-16T15:00:00Z",
      underlyingPx: 120,
      putBid: 0.7,
      putAsk: 0.9,
      putMid: 0.8,
      fill: 0.85,
      pnl: 115,
      finalActualPnl: null,
    };
    const summary = summarizeShadowExits([row]).find((s) => s.ruleId === "tp50");
    expect(summary?.count).toBe(1);
    expect(summary?.totalPnl).toBe(115);
    expect(summary?.avgVsActual).toBeNull();
  });
});
