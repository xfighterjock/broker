import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OptionExpiry, OptionLeg } from "../shared/types";
import { defaultSleeves } from "../shared/types";
import {
  expirySkipReason,
  formatOptionFetchUnavailable,
  pickCreditLegAutoPut,
  runAutopilot,
  type AutoVertical,
} from "../server/src/autopilot";
import * as eventGateAlerts from "../server/src/eventGateAlerts";
import { setPaperNow } from "../server/src/vertical";

const oct9: OptionExpiry = {
  year: 2026,
  month: 10,
  day: 9,
  expiry: "2026-10-09",
  expiryType: "MONTHLY",
};

function hygLeg(strike: number, bid: number, ask: number): OptionLeg {
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

const liquidHyg: OptionLeg[] = [hygLeg(79, 0.4, 0.42), hygLeg(78.5, 0.2, 0.22)];

const equityPuts: OptionLeg[] = [
  {
    underlying: "SPY",
    osiKey: "O:SPY261009P00500000",
    displaySymbol: "SPY P 500",
    right: "P",
    strike: 500,
    expiry: "2026-10-09",
    bid: 6.1,
    ask: 6.3,
    last: 6.2,
    bidSize: 10,
    askSize: 10,
    openInterest: 100,
    delta: -0.5,
    gamma: 0.01,
    theta: -0.02,
    vega: 0.1,
    iv: 0.2,
  },
  {
    underlying: "SPY",
    osiKey: "O:SPY261009P00490000",
    displaySymbol: "SPY P 490",
    right: "P",
    strike: 490,
    expiry: "2026-10-09",
    bid: 3.4,
    ask: 3.6,
    last: 3.5,
    bidSize: 10,
    askSize: 10,
    openInterest: 100,
    delta: -0.4,
    gamma: 0.01,
    theta: -0.02,
    vega: 0.1,
    iv: 0.2,
  },
];

describe("option expiry / chain fetch diagnostics", () => {
  beforeEach(() => setPaperNow(new Date("2026-09-03T13:50:00.000Z")));
  afterEach(() => {
    setPaperNow(null);
    vi.restoreAllMocks();
  });

  it("formats fetch failures with the error and optional status", () => {
    expect(formatOptionFetchUnavailable("expiries", { error: "auth required" })).toBe(
      "option expiries unavailable: auth required",
    );
    expect(formatOptionFetchUnavailable("expiries", { error: "empty body", status: 502 })).toBe(
      "option expiries unavailable: empty body (status 502)",
    );
    expect(formatOptionFetchUnavailable("chain", { error: "timeout", status: 504 })).toBe(
      "option chain unavailable: timeout (status 504)",
    );
  });

  it("distinguishes empty list from nonempty-but-outside the 30–45 DTE band", () => {
    const now = new Date("2026-09-03T13:50:00.000Z");
    expect(expirySkipReason([], now)).toBe("option expiries empty");
    const tooFar: OptionExpiry = {
      year: 2026,
      month: 12,
      day: 18,
      expiry: "2026-12-18",
      expiryType: "MONTHLY",
    };
    expect(expirySkipReason([tooFar], now)).toMatch(/^no 30–45 DTE expiry \(1 listed, nearest \d+ DTE\)$/);
    expect(expirySkipReason([oct9], now)).toBeNull();
  });

  it("credit-leg: failed fetch logs unavailable and does not note an OI skip", async () => {
    const skip = vi.spyOn(eventGateAlerts, "noteCreditLegOiSkip").mockResolvedValue(null);
    const logs: string[] = [];
    const placed: AutoVertical[] = [];
    await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: true, hygAbove200: false },
      riskoffQuotes: [{ symbol: "HYG", last: 79 }],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v) => {
        placed.push(v);
        return { ok: true };
      },
      fetchExpiries: async () => ({
        ok: false,
        error: "E*TRADE auth expired",
        status: 401,
      }),
      fetchChain: async () => liquidHyg,
      log: (line) => logs.push(line),
    });
    expect(placed).toEqual([]);
    expect(skip).not.toHaveBeenCalled();
    expect(logs.some((l) => /vertical skip HYG: option expiries unavailable: E\*TRADE auth expired \(status 401\)/.test(l))).toBe(
      true,
    );
    expect(logs.some((l) => /no 30–45 DTE expiry/.test(l))).toBe(false);
  });

  it("credit-leg: empty expiries vs no-band are distinct skip reasons", async () => {
    const emptyLogs: string[] = [];
    await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: true, hygAbove200: false },
      riskoffQuotes: [{ symbol: "HYG", last: 79 }],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async () => ({ ok: true }),
      fetchExpiries: async () => [],
      fetchChain: async () => liquidHyg,
      log: (line) => emptyLogs.push(line),
    });
    expect(emptyLogs.some((l) => /vertical skip HYG: option expiries empty/.test(l))).toBe(true);

    const bandLogs: string[] = [];
    await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: true, hygAbove200: false },
      riskoffQuotes: [{ symbol: "HYG", last: 79 }],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async () => ({ ok: true }),
      fetchExpiries: async () => [
        { year: 2026, month: 12, day: 18, expiry: "2026-12-18", expiryType: "MONTHLY" },
      ],
      fetchChain: async () => liquidHyg,
      log: (line) => bandLogs.push(line),
    });
    expect(bandLogs.some((l) => /vertical skip HYG: no 30–45 DTE expiry/.test(l))).toBe(true);
    expect(bandLogs.some((l) => /no monthly 21–60/.test(l))).toBe(true);
    expect(bandLogs.some((l) => /option expiries empty/.test(l))).toBe(false);
  });

  it("equity-index ATM: failed fetch and empty list are distinct; success still places", async () => {
    const failLogs: string[] = [];
    await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false, hygAbove200: true },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
      ],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async () => ({ ok: true }),
      fetchExpiries: async () => ({ ok: false, error: "empty body", status: 502 }),
      fetchChain: async () => equityPuts,
      log: (line) => failLogs.push(line),
    });
    expect(failLogs.some((l) => /vertical skip SPY: option expiries unavailable: empty body \(status 502\)/.test(l))).toBe(
      true,
    );

    const placed: AutoVertical[] = [];
    await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false, hygAbove200: true },
      riskoffQuotes: [{ symbol: "SPY", last: 500 }],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v) => {
        placed.push(v);
        return { ok: true };
      },
      fetchExpiries: async () => [oct9],
      fetchChain: async () => equityPuts,
      log: () => {},
    });
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ symbol: "SPY", right: "P", expiry: "2026-10-09" });
  });

  it("credit-leg chain fetch failure is logged as unavailable, not an OI skip", async () => {
    const skip = vi.spyOn(eventGateAlerts, "noteCreditLegOiSkip").mockResolvedValue(null);
    const logs: string[] = [];
    const result = await pickCreditLegAutoPut({
      symbol: "HYG",
      last: 79,
      expiries: [oct9],
      fetchChain: async () => ({ ok: false, error: "timeout", status: 504 }),
      now: new Date("2026-09-03T13:50:00.000Z"),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("option chain unavailable: timeout (status 504)");
      expect(result.noteOiSkip).toBe(false);
    }

    await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: true, hygAbove200: false },
      riskoffQuotes: [{ symbol: "HYG", last: 79 }],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async () => ({ ok: true }),
      fetchExpiries: async () => [oct9],
      fetchChain: async () => ({ ok: false, error: "timeout", status: 504 }),
      log: (line) => logs.push(line),
    });
    expect(skip).not.toHaveBeenCalled();
    expect(logs.some((l) => /vertical skip HYG: option chain unavailable: timeout \(status 504\)/.test(l))).toBe(
      true,
    );
  });
});
