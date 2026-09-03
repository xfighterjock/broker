import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OptionLeg } from "../shared/types";
import { defaultSleeves } from "../shared/types";
import {
  checkCreditLegAutoLiquidity,
  checkHygAutoLiquidity,
  riskoffCreditLegPutAllowed,
  riskoffEquityPutsAllowed,
  runAutopilot,
  type AutoVertical,
} from "../server/src/autopilot";
import {
  RISKOFF_CREDIT_LEG_MAX_AUTO_QTY,
  RISKOFF_CREDIT_LEG_MAX_ROUNDTRIP_SLIPPAGE_FRAC,
  RISKOFF_CREDIT_LEG_MIN_OPEN_INTEREST,
  RISKOFF_HYG_MAX_AUTO_QTY,
  RISKOFF_HYG_MAX_ROUNDTRIP_SLIPPAGE_FRAC,
  RISKOFF_HYG_MIN_OPEN_INTEREST,
} from "../shared/constants";
import { setPaperNow } from "../server/src/vertical";

function creditLeg(
  underlying: string,
  strike: number,
  bid: number,
  ask: number,
  extra: Partial<OptionLeg> = {},
): OptionLeg {
  return {
    underlying,
    osiKey: `O:${underlying}261009P${String(strike * 1000).padStart(8, "0")}`,
    displaySymbol: `${underlying} P ${strike}`,
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

function equityPutLeg(strike: number, bid: number, ask: number): OptionLeg {
  return creditLeg("SPY", strike, bid, ask);
}

const healthy = (u: string, atm: number): OptionLeg[] => [
  creditLeg(u, atm, 0.41, 0.42),
  creditLeg(u, atm - 0.5, 0.19, 0.2),
];
const thin = (u: string, atm: number): OptionLeg[] => [
  creditLeg(u, atm, 0.4, 0.42, { openInterest: 7 }),
  creditLeg(u, atm - 0.5, 0.2, 0.22, { openInterest: 0 }),
];
const equityChain: OptionLeg[] = [equityPutLeg(500, 6.1, 6.3), equityPutLeg(490, 3.4, 3.6)];

describe("credit-leg liquidity aliases keep the HYG envelope", () => {
  it("RISKOFF_CREDIT_LEG_* aliases match RISKOFF_HYG_* numbers", () => {
    expect(RISKOFF_CREDIT_LEG_MIN_OPEN_INTEREST).toBe(RISKOFF_HYG_MIN_OPEN_INTEREST);
    expect(RISKOFF_CREDIT_LEG_MAX_ROUNDTRIP_SLIPPAGE_FRAC).toBe(
      RISKOFF_HYG_MAX_ROUNDTRIP_SLIPPAGE_FRAC,
    );
    expect(RISKOFF_CREDIT_LEG_MAX_AUTO_QTY).toBe(RISKOFF_HYG_MAX_AUTO_QTY);
    expect(RISKOFF_CREDIT_LEG_MIN_OPEN_INTEREST).toBe(100);
    expect(RISKOFF_CREDIT_LEG_MAX_AUTO_QTY).toBe(3);
  });

  it("checkCreditLegAutoLiquidity refuses thin LQD legs; HYG wrapper stays equivalent", () => {
    const long = creditLeg("LQD", 108, 0.4, 0.42, { openInterest: 7 });
    const short = creditLeg("LQD", 107.5, 0.2, 0.22, { openInterest: 0 });
    const gate = checkCreditLegAutoLiquidity("LQD", long, short);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toMatch(/LQD.*open interest/i);
    const hygLong = creditLeg("HYG", 79, 0.41, 0.42);
    const hygShort = creditLeg("HYG", 78.5, 0.19, 0.2);
    expect(checkHygAutoLiquidity(hygLong, hygShort)).toEqual(
      checkCreditLegAutoLiquidity("HYG", hygLong, hygShort),
    );
  });
});

describe("credit-leg put allowance is own-200, not spyAbove200", () => {
  it("LQD/JNK require RISK OFF and own 200 below; missing fails closed", () => {
    expect(riskoffCreditLegPutAllowed(false, false)).toBe(true);
    expect(riskoffCreditLegPutAllowed(false, true)).toBe(false);
    expect(riskoffCreditLegPutAllowed(false, undefined)).toBe(false);
    expect(riskoffCreditLegPutAllowed(false, null)).toBe(false);
    expect(riskoffCreditLegPutAllowed(true, false)).toBe(false);
    expect(riskoffEquityPutsAllowed(false, true)).toBe(false);
    expect(riskoffEquityPutsAllowed(false, false)).toBe(true);
  });
});

describe("runAutopilot: LQD/JNK credit-leg puts", () => {
  beforeEach(() => setPaperNow(new Date("2026-09-03T13:50:00.000Z")));
  afterEach(() => setPaperNow(null));

  const expiry = [{ year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" as const }];

  function chainFor(symbol: string, overrides: Record<string, OptionLeg[]> = {}): OptionLeg[] {
    if (overrides[symbol]) return overrides[symbol];
    if (symbol === "HYG") return healthy("HYG", 79);
    if (symbol === "LQD") return healthy("LQD", 108);
    if (symbol === "JNK") return healthy("JNK", 76);
    return equityChain;
  }

  async function paperPuts(opts: {
    checks: Record<string, boolean | null | undefined>;
    quotes?: Array<{ symbol: string; last: number }>;
    chains?: Record<string, OptionLeg[]>;
  }) {
    const placed: Array<{ symbol: string; qty?: number; thesis: string }> = [];
    const logs: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: opts.checks,
      riskoffQuotes: opts.quotes ?? [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "HYG", last: 77 },
        { symbol: "LQD", last: 108 },
        { symbol: "JNK", last: 76 },
      ],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v: AutoVertical) => {
        placed.push({ symbol: v.symbol, qty: v.qty, thesis: v.thesis });
        return { ok: true };
      },
      fetchExpiries: async () => expiry,
      fetchChain: async (symbol: string) => chainFor(symbol, opts.chains),
      log: (line) => logs.push(line),
    });
    return { placed, logs, result };
  }

  it("opens LQD in HYG-only OFF when LQD is below its own 200dma", async () => {
    const { placed, result } = await paperPuts({
      checks: { spyAbove200: true, hygAbove200: true, lqdAbove200: false },
    });
    expect(placed.map((p) => p.symbol)).toEqual(["LQD"]);
    expect(placed[0].qty).toBe(RISKOFF_CREDIT_LEG_MAX_AUTO_QTY);
    expect(placed[0].thesis).toMatch(/credit-leg/);
    expect(result.verticals.map((v) => v.symbol)).toEqual(["LQD"]);
  });

  it("opens JNK when JNK is below 200 and HYG/LQD are not", async () => {
    const { placed } = await paperPuts({
      checks: { spyAbove200: true, hygAbove200: true, lqdAbove200: true, jnkAbove200: false },
    });
    expect(placed.map((p) => p.symbol)).toEqual(["JNK"]);
    expect(placed[0].qty).toBe(3);
  });

  it("blocks LQD/JNK when own 200dma is missing even if SPY is below 200", async () => {
    const { placed } = await paperPuts({
      checks: { spyAbove200: false, hygAbove200: true },
    });
    expect(placed.map((p) => p.symbol)).toEqual(["SPY", "QQQ"]);
    expect(placed.some((p) => p.symbol === "LQD" || p.symbol === "JNK")).toBe(false);
    for (const p of placed) expect(p.qty).toBeUndefined();
  });

  it("blocks LQD when LQD is above 200 even if SPY is below 200", async () => {
    const { placed } = await paperPuts({
      checks: { spyAbove200: false, hygAbove200: true, lqdAbove200: true, jnkAbove200: true },
    });
    expect(placed.map((p) => p.symbol)).toEqual(["SPY", "QQQ"]);
  });

  it("skips thin HYG and papers LQD instead of sitting idle (HYG-only OFF)", async () => {
    const { placed, logs } = await paperPuts({
      checks: { spyAbove200: true, hygAbove200: false, lqdAbove200: false, jnkAbove200: true },
      chains: { HYG: thin("HYG", 79) },
    });
    expect(placed.map((p) => p.symbol)).toEqual(["LQD"]);
    expect(placed[0].qty).toBe(3);
    expect(logs.some((l) => /HYG/.test(l) && /open interest/i.test(l))).toBe(true);
  });

  it("fill order HYG then LQD then JNK fills the cap of 3 with no equity puts", async () => {
    const { placed } = await paperPuts({
      checks: {
        spyAbove200: false,
        hygAbove200: false,
        lqdAbove200: false,
        jnkAbove200: false,
      },
    });
    expect(placed.map((p) => p.symbol)).toEqual(["HYG", "LQD", "JNK"]);
    expect(placed.every((p) => p.qty === 3)).toBe(true);
  });

  it("equity-index puts still require spyAbove200 and keep uncapped qty", async () => {
    const { placed } = await paperPuts({
      checks: { spyAbove200: false, hygAbove200: true, lqdAbove200: true, jnkAbove200: true },
    });
    expect(placed.map((p) => p.symbol)).toEqual(["SPY", "QQQ"]);
    expect(placed.every((p) => p.qty === undefined)).toBe(true);
  });
});
