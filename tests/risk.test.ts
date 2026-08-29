import { afterEach, describe, expect, it, vi } from "vitest";
import { featuresFromBars, type ScanFeatures } from "../server/src/scan";
import {
  RISK_UUP_VETO_FRAC,
  resetRiskCache,
  riskFromFeatures,
  riskOffFallback,
  uup20dReturn,
} from "../server/src/risk";
import { decideBuys, decideCallVerticalIntents, runAutopilot } from "../server/src/autopilot";
import { defaultSleeves, type ScanRow } from "../shared/types";
import { setPaperNow } from "../server/src/vertical";

afterEach(() => {
  resetRiskCache();
  vi.unstubAllGlobals();
  setPaperNow(null);
});

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

function row(symbol: string, extra: Partial<ScanRow> = {}): ScanRow {
  return {
    symbol,
    name: symbol,
    sector: "Information Technology",
    last: 100,
    pctFrom52: -0.02,
    dist20: 0.01,
    above200: true,
    ret3m: 0.1,
    ret6m: 0.2,
    ret12m: 0.3,
    rs3m: 0.05,
    volx: 1,
    score: 0.22,
    why: "above 200 · pullback 20dma",
    ...extra,
  };
}

describe("riskFromFeatures", () => {
  it("is risk-on only when SPY, ACWI, HYG are above 200dma and UUP 20d is not a veto", () => {
    const on = riskFromFeatures({
      spy: feat(true),
      acwi: feat(true),
      hyg: feat(true),
      uup20dPct: 0.01,
    });
    expect(on.riskOn).toBe(true);
    expect(on.checks.dollarVeto).toBe(false);
    expect(RISK_UUP_VETO_FRAC).toBe(0.03);
  });

  it("fails closed when a 200dma series is missing", () => {
    const off = riskFromFeatures({
      spy: feat(true),
      acwi: null,
      hyg: feat(true),
      uup20dPct: 0,
    });
    expect(off.riskOn).toBe(false);
    expect(off.checks.acwiAbove200).toBe(false);
  });

  it("dollar-vetoes when UUP 20d > +3% or the series is missing", () => {
    const veto = riskFromFeatures({
      spy: feat(true),
      acwi: feat(true),
      hyg: feat(true),
      uup20dPct: 0.031,
    });
    expect(veto.riskOn).toBe(false);
    expect(veto.checks.dollarVeto).toBe(true);
    const missing = riskFromFeatures({
      spy: feat(true),
      acwi: feat(true),
      hyg: feat(true),
      uup20dPct: null,
    });
    expect(missing.riskOn).toBe(false);
    expect(missing.checks.dollarVeto).toBe(true);
    expect(riskOffFallback().riskOn).toBe(false);
  });
});

describe("uup20dReturn", () => {
  it("is last/close[-20] - 1 from fixture bars only", () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const bars = closes.map((close) => ({ close, volume: 1 }));
    const ret = uup20dReturn(bars);
    const last = closes[closes.length - 1];
    const base = closes[closes.length - 1 - 20];
    expect(ret).toBeCloseTo(last / base - 1);
    expect(uup20dReturn(bars.slice(0, 10))).toBeNull();
    expect(featuresFromBars(bars.slice(0, 50))).toBeNull();
  });
});

describe("risk-off blocks new buys, not exits", () => {
  it("decideBuys returns nothing when risk-off", () => {
    const buys = decideBuys(
      [row("AAPL")],
      [],
      defaultSleeves().momentum,
      false,
    );
    expect(buys).toEqual([]);
    const owns = decideBuys([row("JPM")], [], defaultSleeves().ownership, false);
    expect(owns).toEqual([]);
  });

  it("decideCallVerticalIntents returns nothing when risk-off and never puts", () => {
    const off = decideCallVerticalIntents(
      [row("AAPL"), row("MES=F")],
      [],
      defaultSleeves().options,
      false,
    );
    expect(off).toEqual([]);
    const on = decideCallVerticalIntents(
      [row("AAPL"), row("MES=F"), row("SPCX", { sector: "Financials" })],
      [],
      defaultSleeves().options,
      true,
    );
    expect(on.map((i) => i.symbol)).toEqual(["AAPL", "SPCX"]);
    expect(on.every((i) => i.sleeveId === "options")).toBe(true);
  });

  it("runAutopilot risk-off still sells but does not buy or open verticals", async () => {
    const placed: string[] = [];
    const closed: string[] = [];
    const verts: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [
        {
          id: "p1",
          symbol: "DELL",
          root: null,
          qty: 1,
          side: "Long",
          avgPrice: 100,
          unrealizedPnl: 0,
          gated: false,
          sleeveId: "momentum",
        },
      ],
      getSleeves: () => defaultSleeves(),
      momentumRows: [row("AAPL")],
      featureRows: [{ symbol: "DELL", above200: false }],
      scanReady: true,
      riskOn: false,
      place: async (b) => {
        placed.push(b.symbol);
        return { ok: true };
      },
      close: async (s) => {
        closed.push(s.symbol);
        return { ok: true };
      },
      placeVertical: async (v) => {
        verts.push(`${v.right}:${v.symbol}`);
        return { ok: true };
      },
      fetchExpiries: async () => [{ year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" }],
      fetchChain: async () => [],
      log: () => {},
    });
    expect(placed).toEqual([]);
    expect(verts).toEqual([]);
    expect(result.bought).toEqual([]);
    expect(result.verticals).toEqual([]);
    expect(closed).toEqual(["DELL"]);
  });

  it("debit-call auto never sells puts", async () => {
    setPaperNow(new Date("2026-08-24T14:00:00Z")); // Mon 10:00 ET
    const rights: string[] = [];
    const nowRows = [row("AAPL", { last: 67 })];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: nowRows,
      featureRows: [],
      scanReady: true,
      riskOn: true,
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v) => {
        rights.push(v.right);
        expect(v.right).toBe("C");
        return { ok: true };
      },
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async () => [
        {
          underlying: "AAPL",
          osiKey: "O:AAPL261009C00065000",
          displaySymbol: "AAPL C 65",
          right: "C",
          strike: 65,
          expiry: "2026-10-09",
          bid: 4.9,
          ask: 5,
          last: 5.15,
          bidSize: 1,
          askSize: 1,
          openInterest: 10,
          delta: 0.5,
          gamma: 0.01,
          theta: -0.02,
          vega: 0.1,
          iv: 0.2,
        },
        {
          underlying: "AAPL",
          osiKey: "O:AAPL261009C00070000",
          displaySymbol: "AAPL C 70",
          right: "C",
          strike: 70,
          expiry: "2026-10-09",
          bid: 2.5,
          ask: 2.6,
          last: 2.45,
          bidSize: 1,
          askSize: 1,
          openInterest: 10,
          delta: 0.3,
          gamma: 0.01,
          theta: -0.02,
          vega: 0.1,
          iv: 0.2,
        },
        {
          underlying: "AAPL",
          osiKey: "O:AAPL261009P00065000",
          displaySymbol: "AAPL P 65",
          right: "P",
          strike: 65,
          expiry: "2026-10-09",
          bid: 1.4,
          ask: 1.5,
          last: 1.45,
          bidSize: 1,
          askSize: 1,
          openInterest: 10,
          delta: -0.4,
          gamma: 0.01,
          theta: -0.02,
          vega: 0.1,
          iv: 0.2,
        },
      ],
      log: () => {},
    });
    expect(rights).toEqual(["C"]);
    expect(result.verticals).toHaveLength(1);
    expect(result.verticals[0].right).toBe("C");
    expect(result.verticals[0].longStrike).toBe(65);
    expect(result.verticals[0].shortStrike).toBe(70);
  });
});
