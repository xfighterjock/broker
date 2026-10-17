import { afterEach, describe, expect, it } from "vitest";
import type { ScanFeatures } from "../server/src/scan";
import { featuresFromBars } from "../server/src/scan";
import {
  applyAbove200Staleness,
  above200FromBars,
  resetRiskCache,
  riskFromFeatures,
  riskOffFallback,
  riskTooltip,
} from "../server/src/risk";
import { riskFlipBody } from "../server/src/eventGateAlerts";
import { decideBuys, decideCallVerticalIntents } from "../server/src/autopilot";
import { defaultSleeves, type ScanRow } from "../shared/types";

afterEach(() => {
  resetRiskCache();
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

function row(symbol: string): ScanRow {
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
    why: "above 200",
  };
}

describe("missing bars stay missing on the regime badge", () => {
  it("a full fallback is RISK OFF with null checks, not a below-200 print", () => {
    const fallback = riskOffFallback();
    expect(fallback.riskOn).toBe(false);
    expect(fallback.checks.spyAbove200).toBeNull();
    expect(fallback.checks.acwiAbove200).toBeNull();
    expect(fallback.checks.hygAbove200).toBeNull();
    expect(fallback.checks.uup20dPct).toBeNull();
    expect(fallback.checks.dollarVeto).toBe(true);
    expect(fallback).not.toHaveProperty("creditLegAbove200");
    expect(riskTooltip(fallback)).toMatch(/SPY 200dma missing/);
    expect(riskTooltip(fallback)).toMatch(/ACWI 200dma missing/);
    expect(riskTooltip(fallback)).toMatch(/HYG 200dma missing/);
    expect(riskTooltip(fallback)).not.toMatch(/below 200dma/);
    expect(riskFlipBody(fallback)).toMatch(/SPY 200dma missing/);
    expect(riskFlipBody(fallback)).not.toMatch(/below 200dma/);
    expect(above200FromBars(null)).toBeNull();
    expect(featuresFromBars([{ close: 1, volume: 1 }])).toBeNull();
  });

  it("one SPY miss after a real read is carried, and the third miss publishes null", () => {
    const good = riskFromFeatures({
      spy: feat(true),
      acwi: feat(true),
      hyg: feat(false),
      uup20dPct: 0.01,
    });
    expect(applyAbove200Staleness(good).checks.spyAbove200).toBe(true);
    const missed = riskFromFeatures({
      spy: null,
      acwi: feat(true),
      hyg: feat(false),
      uup20dPct: 0.01,
    });
    expect(applyAbove200Staleness(missed).checks.spyAbove200).toBe(true);
    expect(applyAbove200Staleness(missed).checks.spyAbove200).toBe(true);
    const expired = applyAbove200Staleness(missed);
    expect(expired.checks.spyAbove200).toBeNull();
    expect(expired.checks.hygAbove200).toBe(false);
    expect(expired.riskOn).toBe(false);
    expect(riskTooltip(expired)).toMatch(/SPY 200dma missing/);
    expect(riskTooltip(expired)).toMatch(/HYG below 200dma/);
    expect(riskTooltip(expired)).not.toMatch(/SPY below 200dma/);
  });

  it("does not carry the dollar veto, and does not invent below-200 before any read", () => {
    const good = riskFromFeatures({
      spy: feat(true),
      acwi: feat(true),
      hyg: feat(true),
      uup20dPct: 0.01,
    });
    applyAbove200Staleness(good);
    const uupMissing = applyAbove200Staleness(
      riskFromFeatures({
        spy: feat(true),
        acwi: feat(true),
        hyg: feat(true),
        uup20dPct: null,
      }),
    );
    expect(uupMissing.checks.dollarVeto).toBe(true);
    expect(uupMissing.riskOn).toBe(false);
    expect(uupMissing.checks.spyAbove200).toBe(true);

    resetRiskCache();
    const first = applyAbove200Staleness(riskOffFallback());
    expect(first.checks.spyAbove200).toBeNull();
    expect(first.checks.hygAbove200).toBeNull();
    expect(riskTooltip(first)).toMatch(/SPY 200dma missing/);
    expect(riskTooltip(first)).not.toMatch(/below 200dma/);
  });

  it("keeps momentum and options entries off while the badge is fail-closed", () => {
    expect(decideBuys([row("AAPL")], [], defaultSleeves().momentum, false)).toEqual([]);
    expect(decideBuys([row("JPM")], [], defaultSleeves().ownership, false)).toEqual([]);
    expect(decideCallVerticalIntents([row("AAPL")], [], defaultSleeves().options, false)).toEqual([]);
    const on = decideCallVerticalIntents([row("AAPL")], [], defaultSleeves().options, true);
    expect(on.map((v) => v.symbol)).toEqual(["AAPL"]);
    expect(on.every((v) => v.sleeveId === "options")).toBe(true);
  });
});
