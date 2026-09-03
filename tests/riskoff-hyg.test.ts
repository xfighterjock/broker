import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OptionLeg } from "../shared/types";
import { defaultSleeves } from "../shared/types";
import { checkHygAutoLiquidity, runAutopilot, type AutoVertical } from "../server/src/autopilot";
import {
  RISKOFF_HYG_MAX_AUTO_QTY,
  RISKOFF_HYG_MAX_ROUNDTRIP_SLIPPAGE_FRAC,
  RISKOFF_HYG_MIN_OPEN_INTEREST,
  RISKOFF_HYG_SYMBOL,
} from "../shared/constants";
import { sizeDebitContracts, setPaperNow } from "../server/src/vertical";


// Real 2026-09-03 incident this gate guards against: HYG 79/78.5P, open
// interest 7/0, auto-sized to 50 contracts on a $0.20 net debit (1% of
// $100k / $20 per contract), 50% debit stop fired ~40 minutes later for a
// realized loss. See shared/constants.ts and docs/DESIGN.md.
function hygLeg(
  strike: number,
  bid: number,
  ask: number,
  extra: Partial<OptionLeg> = {},
): OptionLeg {
  return {
    underlying: "HYG",
    osiKey: `O:HYG261009P${String(strike * 1000).padStart(8, "0")}`,
    displaySymbol: `HYG P ${strike}`,
    right: "P",
    strike,
    expiry: "2026-10-09",
    bid,
    ask,
    last: (bid + ask) / 2,
    bidSize: extra.bidSize ?? 500,
    askSize: extra.askSize ?? 500,
    openInterest: extra.openInterest ?? 500,
    delta: -0.4,
    gamma: 0.01,
    theta: -0.02,
    vega: 0.1,
    iv: 0.2,
  };
}

describe("checkHygAutoLiquidity", () => {
  it("refuses the incident's thin legs: 79P OI 7, 78.5P OI 0", () => {
    const long = hygLeg(79, 0.4, 0.42, { openInterest: 7 });
    const short = hygLeg(78.5, 0.2, 0.22, { openInterest: 0 });
    const gate = checkHygAutoLiquidity(long, short);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/open interest/i);
  });

  it("refuses one thin leg even when the other is liquid", () => {
    const long = hygLeg(79, 0.4, 0.42, { openInterest: 500 });
    const short = hygLeg(78.5, 0.2, 0.22, { openInterest: 40 });
    const gate = checkHygAutoLiquidity(long, short);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(new RegExp(`below ${RISKOFF_HYG_MIN_OPEN_INTEREST}`));
  });

  it("refuses a wide round-trip: immediate close < 75% of entry debit (.07 vs .20)", () => {
    // entry natural: longAsk .42 - shortBid .22 = .20 debit.
    // immediate close natural: longBid .36 - shortAsk .29 = .07 (the incident's post-move number,
    // used here as a same-quote wide-market snapshot: each leg's own bid/ask is 6-7 cents wide).
    const long = hygLeg(79, 0.36, 0.42);
    const short = hygLeg(78.5, 0.22, 0.29);
    const gate = checkHygAutoLiquidity(long, short);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/round-trip/);
    // .20 debit * (1 - 0.25) = .15 minimum acceptable immediate close; .07 is well under it.
    expect(0.2 * (1 - RISKOFF_HYG_MAX_ROUNDTRIP_SLIPPAGE_FRAC)).toBeCloseTo(0.15);
  });

  it("passes healthy, liquid, tight-market HYG legs", () => {
    const long = hygLeg(79, 0.41, 0.42, { openInterest: 500 });
    const short = hygLeg(78.5, 0.19, 0.2, { openInterest: 500 });
    const gate = checkHygAutoLiquidity(long, short);
    expect(gate.ok).toBe(true);
  });

  it("refuses when bidSize/askSize cannot fill the final (capped) qty", () => {
    const long = hygLeg(79, 0.41, 0.42, { bidSize: 1 });
    const short = hygLeg(78.5, 0.19, 0.2, { askSize: 1 });
    expect(checkHygAutoLiquidity(long, short, RISKOFF_HYG_MAX_AUTO_QTY).ok).toBe(false);
  });

  it("1% sizing would want far more than the hard cap on a cheap debit — the cap, not the target frac, wins", () => {
    // .20 debit -> $20/contract. 1% of $100k = $1000 -> 50 contracts (the actual incident qty).
    const sized = sizeDebitContracts(0.2, 100_000);
    expect(sized.ok).toBe(true);
    if (sized.ok) expect(sized.qty).toBe(50);
    expect(RISKOFF_HYG_MAX_AUTO_QTY).toBe(3);
    expect(RISKOFF_HYG_MAX_AUTO_QTY).toBeLessThan(sized.ok ? sized.qty : 0);
  });
});

const healthyHygChain: OptionLeg[] = [
  hygLeg(79, 0.41, 0.42),
  hygLeg(78.5, 0.19, 0.2),
];

const thinHygChain: OptionLeg[] = [
  hygLeg(79, 0.4, 0.42, { openInterest: 7 }),
  hygLeg(78.5, 0.2, 0.22, { openInterest: 0 }),
];

function equityPutLeg(strike: number, bid: number, ask: number): OptionLeg {
  return {
    underlying: "SPY",
    osiKey: `O:SPY261009P${String(strike * 1000).padStart(8, "0")}`,
    displaySymbol: `SPY P ${strike}`,
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

const equityChain: OptionLeg[] = [equityPutLeg(500, 6.1, 6.3), equityPutLeg(490, 3.4, 3.6)];

describe("runAutopilot: HYG gate applies only to the HYG riskoff auto entry", () => {
  beforeEach(() => setPaperNow(new Date("2026-09-03T13:50:00.000Z"))); // Thu 08:50 CT / 09:50 ET
  afterEach(() => setPaperNow(null));

  it("skips HYG on thin open interest but still opens SPY/QQQ", async () => {
    const placed: Array<{ symbol: string; qty?: number }> = [];
    const logs: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false, hygAbove200: false },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "HYG", last: 77 },
      ],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v: AutoVertical) => {
        placed.push({ symbol: v.symbol, qty: v.qty });
        return { ok: true };
      },
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async (symbol: string) =>
        symbol === RISKOFF_HYG_SYMBOL ? thinHygChain : equityChain,
      log: (line) => logs.push(line),
    });
    expect(placed.map((p) => p.symbol)).toEqual(["SPY", "QQQ"]);
    expect(result.verticals.map((v) => v.symbol)).toEqual(["SPY", "QQQ"]);
    expect(logs.some((l) => /HYG/.test(l) && /open interest/i.test(l))).toBe(true);
  });

  it("skips HYG on a wide round-trip spread but still opens SPY/QQQ", async () => {
    const placed: string[] = [];
    const wideHygChain: OptionLeg[] = [hygLeg(79, 0.36, 0.42), hygLeg(78.5, 0.22, 0.29)];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false, hygAbove200: false },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "HYG", last: 77 },
      ],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v: AutoVertical) => {
        placed.push(v.symbol);
        return { ok: true };
      },
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async (symbol: string) =>
        symbol === RISKOFF_HYG_SYMBOL ? wideHygChain : equityChain,
      log: () => {},
    });
    expect(placed).toEqual(["SPY", "QQQ"]);
    expect(result.verticals.some((v) => v.symbol === RISKOFF_HYG_SYMBOL)).toBe(false);
  });

  it("caps healthy HYG at RISKOFF_HYG_MAX_AUTO_QTY (3) regardless of 1% target sizing, leaves SPY/QQQ unlimited", async () => {
    const placed: Array<{ symbol: string; qty?: number }> = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false, hygAbove200: false },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "HYG", last: 77 },
      ],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v: AutoVertical) => {
        placed.push({ symbol: v.symbol, qty: v.qty });
        return { ok: true };
      },
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async (symbol: string) =>
        symbol === RISKOFF_HYG_SYMBOL ? healthyHygChain : equityChain,
      log: () => {},
    });
    expect(placed.map((p) => p.symbol)).toEqual(["HYG", "SPY", "QQQ"]);
    const hyg = placed.find((p) => p.symbol === RISKOFF_HYG_SYMBOL);
    expect(hyg?.qty).toBe(RISKOFF_HYG_MAX_AUTO_QTY);
    expect(hyg?.qty).toBeLessThanOrEqual(3);
    // SPY/QQQ auto-size at 1% (unbounded by the HYG-only cap) — qty stays undefined
    // on the intent so validateDebitVertical does the usual 1%/2% sizing downstream.
    for (const p of placed.filter((p) => p.symbol !== RISKOFF_HYG_SYMBOL)) {
      expect(p.qty).toBeUndefined();
    }
  });
});
