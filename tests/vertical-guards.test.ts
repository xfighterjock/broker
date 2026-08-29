import { afterEach, describe, expect, it } from "vitest";
import {
  OPTIONS_DEBIT_MAX_WIDTH_FRAC,
  OPTIONS_VERTICAL_CUTOFF_MINUTES,
} from "../shared/constants";
import type { OptionLeg } from "../shared/types";
import {
  etWall,
  isVerticalStopReason,
  noteVerticalStop,
  setPaperNow,
  validateDebitVertical,
  verticalEntryWindowError,
  verticalEntryWindowOpen,
  verticalStopCooling,
} from "../server/src/vertical";

function callLeg(strike: number, bid: number, ask: number): OptionLeg {
  return {
    underlying: "QQQ",
    osiKey: `O:QQQ261016C${String(Math.round(strike * 1000)).padStart(8, "0")}`,
    displaySymbol: `QQQ C ${strike}`,
    right: "C",
    strike,
    expiry: "2026-10-16",
    bid,
    ask,
    last: (bid + ask) / 2,
    bidSize: 1,
    askSize: 1,
    openInterest: 10,
    delta: 0.4,
    gamma: 0.01,
    theta: -0.02,
    vega: 0.1,
    iv: 0.2,
  };
}

describe("half-width debit cap", () => {
  it("exports OPTIONS_DEBIT_MAX_WIDTH_FRAC = 0.5", () => {
    expect(OPTIONS_DEBIT_MAX_WIDTH_FRAC).toBe(0.5);
  });

  it("allows debit equal to half the width", () => {
    const long = callLeg(500, 1.2, 1.4);
    const short = callLeg(501, 0.9, 1.0);
    const v = validateDebitVertical({ long, short, qty: 1, quoteSymbol: "QQQ" }, 100_000);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.netDebitPerShare).toBeCloseTo(0.5);
    expect(v.width).toBe(1);
  });

  it("refuses QQQ 0.86 debit on $1 width", () => {
    const long = callLeg(500, 1.5, 1.66);
    const short = callLeg(501, 0.8, 0.85);
    const v = validateDebitVertical({ long, short, qty: 1, quoteSymbol: "QQQ" }, 100_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/half the width/);
  });

  it("still refuses debit >= width", () => {
    const long = callLeg(500, 2.0, 2.2);
    const short = callLeg(501, 1.1, 1.2);
    const v = validateDebitVertical({ long, short, qty: 1, quoteSymbol: "QQQ" }, 100_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/width/);
  });
});

describe("vertical entry window (injected clock)", () => {
  afterEach(() => setPaperNow(null));

  it("cutoff is 15:50 ET", () => {
    expect(OPTIONS_VERTICAL_CUTOFF_MINUTES).toBe(15 * 60 + 50);
  });

  it("Fri 15:49 ET is open", () => {
    const t = new Date("2026-08-28T19:49:00Z");
    const w = etWall(t);
    expect(w.weekday).toBe(5);
    expect(w.minutes).toBe(15 * 60 + 49);
    expect(verticalEntryWindowOpen(t)).toBe(true);
    expect(verticalEntryWindowError(t)).toBeNull();
    setPaperNow(t);
    expect(verticalEntryWindowOpen()).toBe(true);
  });

  it("Fri 15:50 ET is closed", () => {
    const t = new Date("2026-08-28T19:50:00Z");
    expect(etWall(t).minutes).toBe(OPTIONS_VERTICAL_CUTOFF_MINUTES);
    expect(verticalEntryWindowOpen(t)).toBe(false);
    expect(verticalEntryWindowError(t)).toBe("no new verticals after 15:50 ET");
    setPaperNow(t);
    expect(verticalEntryWindowOpen()).toBe(false);
  });

  it("Saturday is closed", () => {
    const t = new Date("2026-08-29T14:00:00Z");
    expect(etWall(t).weekday).toBe(6);
    expect(verticalEntryWindowOpen(t)).toBe(false);
  });

  it("Monday morning is open", () => {
    const t = new Date("2026-08-31T14:00:00Z");
    expect(etWall(t).weekday).toBe(1);
    expect(verticalEntryWindowOpen(t)).toBe(true);
    expect(verticalEntryWindowError(t)).toBeNull();
  });
});

describe("same-day stop cooldown", () => {
  it("cools the same symbol on the same ET day only", () => {
    const fri = new Date("2026-08-28T18:00:00Z");
    const sat = new Date("2026-08-29T14:00:00Z");
    const map = noteVerticalStop({}, "QQQ", fri);
    expect(verticalStopCooling(map, "QQQ", fri)).toBe(true);
    expect(verticalStopCooling(map, "qqq", fri)).toBe(true);
    expect(verticalStopCooling(map, "SPY", fri)).toBe(false);
    expect(verticalStopCooling(map, "QQQ", sat)).toBe(false);
  });

  it("isVerticalStopReason matches debit stop, not profit-take or DTE", () => {
    expect(isVerticalStopReason("50% debit stop")).toBe(true);
    expect(isVerticalStopReason("50% max profit")).toBe(false);
    expect(isVerticalStopReason("DTE 21 <= 21")).toBe(false);
  });
});
