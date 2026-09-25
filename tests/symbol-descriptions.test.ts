import { describe, expect, it } from "vitest";
import {
  GATED_ROOTS,
  OPTIONS_V1_SYMBOLS,
  RISKOFF_CREDIT_LEG_SYMBOLS,
  RISKOFF_ETF_SYMBOLS,
  RISKOFF_QUOTE_STRIP,
} from "../shared/constants";
import {
  SYMBOL_DESCRIPTIONS,
  splitInstrumentLabels,
  symbolDescription,
  symbolHoverTitle,
} from "../shared/symbolDescriptions";

const METHODOLOGY = [
  ...RISKOFF_QUOTE_STRIP,
  ...RISKOFF_ETF_SYMBOLS,
  ...RISKOFF_CREDIT_LEG_SYMBOLS,
  ...OPTIONS_V1_SYMBOLS,
  ...GATED_ROOTS,
  "ACWI",
] as const;

describe("symbol descriptions", () => {
  it("names every Event Gate quote, overlay, credit, options, and gated root", () => {
    for (const symbol of METHODOLOGY) {
      expect(symbolDescription(symbol), symbol).toBeTruthy();
      expect(SYMBOL_DESCRIPTIONS[symbol], symbol).toBe(symbolDescription(symbol));
    }
  });

  it("uses the documented product names for PDBC, GDX, HYG, and MES", () => {
    expect(symbolDescription("PDBC")).toBe(
      "Invesco Optimum Yield Diversified Commodity Strategy ETF",
    );
    expect(symbolDescription("GDX")).toBe("VanEck Gold Miners ETF");
    expect(symbolDescription("QUAL")).toBe("iShares MSCI USA Quality Factor ETF");
    expect(symbolDescription("BTAL")).toBe("AGF U.S. Market Neutral Anti-Beta Fund");
    expect(symbolDescription("HYG")).toBe("iShares iBoxx $ High Yield Corporate Bond ETF");
    expect(symbolDescription("MES")).toBe("CME Micro E-mini S&P 500 futures");
    expect(symbolDescription("hyg")).toBe(symbolDescription("HYG"));
  });

  it("resolves dated futures, Yahoo =F, and option packages to the root or underlying", () => {
    expect(symbolDescription("MESU6")).toBe(symbolDescription("MES"));
    expect(symbolDescription("MNQU5")).toBe(symbolDescription("MNQ"));
    expect(symbolDescription("ESH26")).toBe(symbolDescription("ES"));
    expect(symbolDescription("M6EU6")).toBe(symbolDescription("M6E"));
    expect(symbolDescription("6EH6")).toBe(symbolDescription("6E"));
    expect(symbolDescription("MES=F")).toBe(symbolDescription("MES"));
    expect(symbolDescription("F:ZN")).toBe(symbolDescription("ZN"));
    expect(symbolDescription("SPY 500/495 P 2026-10-16")).toBe(symbolDescription("SPY"));
    expect(symbolDescription("HYG 79/78.5 P 2026-10-16")).toBe(symbolDescription("HYG"));
    expect(symbolDescription("SPY 450 P 2026-10-16 CSP")).toBe(symbolDescription("SPY"));
    expect(symbolDescription("SPY240920C00500000")).toBe(symbolDescription("SPY"));
  });

  it("does not treat an equity that merely starts with a futures root as that future", () => {
    expect(symbolDescription("ESTC")).toBeNull();
    expect(symbolDescription("AAPL")).toBeNull();
    expect(symbolHoverTitle("AAPL")).toBeUndefined();
    expect(symbolDescription("")).toBeNull();
    expect(symbolDescription("   ")).toBeNull();
  });

  it("splits sleeve instrument lists into hoverable tokens", () => {
    expect(splitInstrumentLabels("MES / ZN / M6E / SR3")).toEqual(["MES", "ZN", "M6E", "SR3"]);
    expect(splitInstrumentLabels("SPY, QQQ, SPY")).toEqual(["SPY", "QQQ"]);
    expect(splitInstrumentLabels("")).toEqual([]);
  });
});
