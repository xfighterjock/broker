import { describe, expect, it } from "vitest";
import { zonedTimeToUtc } from "../shared/clock";
import type { Position } from "../shared/types";
import {
  DAY_STOCH_SYMBOL,
  dayStochArmed,
  decideDayMomentum,
  gateBlocksDayEntries,
  parseYahooFiveMinuteBars,
  sessionVwap,
  stochasticKd,
  stopForLong,
  stopForShort,
  vwapLostSustained,
  type MinuteBar,
} from "../server/src/dayMomentum";

function rth(hour: number, minute: number, close: number, extra: Partial<MinuteBar> = {}): MinuteBar {
  const ts = zonedTimeToUtc(2026, 9, 2, hour, minute, 0).getTime();
  return {
    ts,
    open: close,
    high: extra.high ?? close + 0.5,
    low: extra.low ?? close - 0.5,
    close,
    volume: extra.volume ?? 1000,
    ...extra,
    ts,
  };
}

function pos(side: Position["side"]): Position {
  return {
    id: "p1",
    symbol: "MES=F",
    root: "MES",
    qty: 1,
    side,
    avgPrice: 5000,
    unrealizedPnl: 0,
    gated: true,
    sleeveId: "day",
  };
}

describe("stochasticKd", () => {
  it("is 100 at the 14-bar high close and 0 at the low", () => {
    const lows: MinuteBar[] = [];
    const highs: MinuteBar[] = [];
    for (let i = 0; i < 14; i++) {
      lows.push(rth(9, 30 + i * 5, 0, { high: 10, low: 0, close: 0, volume: 1 }));
      highs.push(rth(9, 30 + i * 5, 10, { high: 10, low: 0, close: 10, volume: 1 }));
    }
    const kLow = stochasticKd(lows, 14, 1, 1)[13].k;
    const kHigh = stochasticKd(highs, 14, 1, 1)[13].k;
    expect(kLow).toBe(0);
    expect(kHigh).toBe(100);
  });
});

describe("sessionVwap", () => {
  it("is typical price when volume is even", () => {
    const bars = [
      rth(9, 30, 10, { high: 12, low: 8, volume: 2 }),
      rth(9, 35, 20, { high: 22, low: 18, volume: 2 }),
    ];
    const v = sessionVwap(bars);
    expect(v).not.toBeNull();
    expect(v!).toBeCloseTo(15, 5);
  });
});

describe("stops", () => {
  it("uses at least 8 ticks (2.00) and widens to the signal bar", () => {
    expect(stopForLong(5000, 4999.5)).toBeCloseTo(4998, 5);
    expect(stopForLong(5000, 4990)).toBeCloseTo(4990, 5);
    expect(stopForShort(5000, 5000.5)).toBeCloseTo(5002, 5);
    expect(stopForShort(5000, 5010)).toBeCloseTo(5010, 5);
  });
});

describe("gateBlocksDayEntries", () => {
  it("blocks every GATE mode except idle", () => {
    expect(gateBlocksDayEntries("idle")).toBe(false);
    expect(gateBlocksDayEntries("PRE-ARM")).toBe(true);
    expect(gateBlocksDayEntries("NO-STOP BAND")).toBe(true);
    expect(gateBlocksDayEntries("SESSION FLATTEN")).toBe(true);
  });
});

function series(n: number, close: number): MinuteBar[] {
  const out: MinuteBar[] = [];
  for (let i = 0; i < n; i++) {
    const total = 9 * 60 + 30 + i * 5;
    out.push(rth(Math.floor(total / 60), total % 60, close, { high: 100, low: 80, volume: 1000 }));
  }
  return out;
}

function longSignalBars(): MinuteBar[] {
  const bars = series(22, 81);
  bars[21] = { ...bars[21], close: 99, high: 100, low: 80 };
  return bars;
}

/** Tight high/low so session VWAP stays near `px` (for exit hysteresis). */
function flatVwapBars(n: number, px: number): MinuteBar[] {
  const out: MinuteBar[] = [];
  for (let i = 0; i < n; i++) {
    const total = 9 * 60 + 30 + i * 5;
    out.push(rth(Math.floor(total / 60), total % 60, px, { high: px, low: px, volume: 1000 }));
  }
  return out;
}

const printDayKnowledge = zonedTimeToUtc(2026, 9, 2, 8, 35, 0).toISOString();

describe("dayStochArmed", () => {
  const noon = zonedTimeToUtc(2026, 9, 2, 11, 20, 0);

  it("is false without knowledge_time and true after a same-ET-day stamp", () => {
    expect(dayStochArmed(noon, null)).toBe(false);
    expect(dayStochArmed(noon, undefined)).toBe(false);
    expect(dayStochArmed(noon, printDayKnowledge)).toBe(true);
    expect(dayStochArmed(noon, zonedTimeToUtc(2026, 9, 1, 10, 0, 0).toISOString())).toBe(false);
    expect(dayStochArmed(noon, zonedTimeToUtc(2026, 9, 2, 12, 0, 0).toISOString())).toBe(false);
  });
});

describe("decideDayMomentum", () => {
  const noon = zonedTimeToUtc(2026, 9, 2, 11, 20, 0);
  const afterFlat = zonedTimeToUtc(2026, 9, 2, 15, 50, 0);

  it("flattens an open MES at 15:45 ET", () => {
    const got = decideDayMomentum({
      now: afterFlat,
      gateMode: "idle",
      bars: series(20, 81),
      positions: [pos("Long")],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
    });
    expect(got.sells[0]?.reason).toMatch(/15:45/);
    expect(got.buy).toBeNull();
  });

  it("refuses new entries in PRE-ARM even after knowledge_time", () => {
    const got = decideDayMomentum({
      now: noon,
      gateMode: "PRE-ARM",
      bars: longSignalBars(),
      positions: [],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      knowledgeTime: printDayKnowledge,
    });
    expect(got.buy).toBeNull();
    expect(got.reason).toMatch(/PRE-ARM/);
  });

  it("refuses new entries in NO-STOP BAND even after knowledge_time", () => {
    const got = decideDayMomentum({
      now: noon,
      gateMode: "NO-STOP BAND",
      bars: longSignalBars(),
      positions: [],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      knowledgeTime: printDayKnowledge,
    });
    expect(got.buy).toBeNull();
    expect(got.reason).toMatch(/NO-STOP BAND/);
  });

  it("does not enter idle RTH on a leftover knowledge_time from another ET day", () => {
    const got = decideDayMomentum({
      now: noon,
      gateMode: "idle",
      bars: longSignalBars(),
      positions: [],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      knowledgeTime: zonedTimeToUtc(2026, 9, 1, 10, 0, 0).toISOString(),
    });
    expect(got.buy).toBeNull();
    expect(got.reason).toMatch(/knowledge_time/);
  });

  it("does not enter idle RTH without knowledge_time", () => {
    const got = decideDayMomentum({
      now: noon,
      gateMode: "idle",
      bars: longSignalBars(),
      positions: [],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      knowledgeTime: null,
    });
    expect(got.buy).toBeNull();
    expect(got.reason).toMatch(/knowledge_time/);
  });

  it("buys MES qty 1 on oversold stoch cross above VWAP after knowledge_time", () => {
    const got = decideDayMomentum({
      now: noon,
      gateMode: "idle",
      bars: longSignalBars(),
      positions: [],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      knowledgeTime: printDayKnowledge,
    });
    expect(got.buy?.sleeveId).toBe("day");
    expect(got.buy?.symbol).toBe(DAY_STOCH_SYMBOL);
    expect(got.buy?.side).toBe("Buy");
    expect(got.buy?.qty).toBe(1);
    expect(got.buy!.stopPrice).toBeLessThan(99);
  });

  it("does not exit on a single completed bar through VWAP", () => {
    const bars = flatVwapBars(20, 100);
    bars[19] = { ...bars[19], close: 99.75, high: 100, low: 99.75 };
    expect(sessionVwap(bars)!).toBeGreaterThan(99.75);
    expect(vwapLostSustained("Long", bars, sessionVwap(bars)!)).toBe(false);
    const got = decideDayMomentum({
      now: noon,
      gateMode: "idle",
      bars,
      positions: [pos("Long")],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
    });
    expect(got.sells).toEqual([]);
    expect(got.reason).toBe("hold");
  });

  it("exits VWAP lost after two consecutive closes on the wrong side", () => {
    const bars = flatVwapBars(20, 100);
    bars[18] = { ...bars[18], close: 99.75, high: 100, low: 99.75 };
    bars[19] = { ...bars[19], close: 99.5, high: 100, low: 99.5 };
    const vwap = sessionVwap(bars)!;
    expect(bars[18].close).toBeLessThan(vwap);
    expect(bars[19].close).toBeLessThan(vwap);
    expect(vwapLostSustained("Long", bars, vwap)).toBe(true);
    const got = decideDayMomentum({
      now: noon,
      gateMode: "idle",
      bars,
      positions: [pos("Long")],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
    });
    expect(got.sells[0]?.reason).toBe("VWAP lost");
    expect(got.reason).toBe("exit VWAP");
    expect(got.buy).toBeNull();
  });

  it("still flattens an open lot on sleeve loss cap without knowledge_time", () => {
    const got = decideDayMomentum({
      now: noon,
      gateMode: "idle",
      bars: flatVwapBars(20, 100),
      positions: [pos("Long")],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: -500,
    });
    expect(got.sells[0]?.reason).toBe("sleeve loss cap");
    expect(got.buy).toBeNull();
  });

  it("parses Yahoo 5m chart timestamps", () => {
    const bars = parseYahooFiveMinuteBars({
      chart: { result: [{ timestamp: [1_000, 1_300], indicators: { quote: [{ open: [1, 2], high: [2, 3], low: [0.5, 1], close: [1.5, 2.5], volume: [10, 20] }] } }] },
    });
    expect(bars).toHaveLength(2);
    expect(bars[1].close).toBe(2.5);
    expect(bars[1].ts).toBe(1_300_000);
  });
});
