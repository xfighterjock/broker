import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OptionLeg, Position } from "../shared/types";
import { defaultSleeves } from "../shared/types";
import {
  DEFAULT_SLEEVE_EQUITY_USD,
  RISKOFF_ETF_HYG_ONLY_INELIGIBLE,
  RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED,
  RISKOFF_ETF_SYMBOLS,
  type RiskoffEtfSymbol,
} from "../shared/constants";
import {
  decidePutVerticalIntents,
  decideRiskoffPutSells,
  riskoffEquityPutsAllowed,
} from "../server/src/autopilot";
import { decideRiskoffDuration } from "../server/src/riskoffDuration";
import {
  decideRiskoffEtf,
  emptyRiskoffEtfAbove200,
  emptyRiskoffEtfReturns,
  resetRiskoffEtfMissingBarsMisses,
  resetRiskoffOverlayRegime,
  resolveRiskoffOverlayRegime,
  riskoffHygOnlyRiskOff,
  sizeRiskoffEtfShares,
  type RiskoffEtfAbove200,
  type RiskoffEtfReturns,
} from "../server/src/riskoffEtf";
import {
  applyAbove200Staleness,
  resetRiskCache,
  riskFromFeatures,
  riskOffFallback,
  riskTooltip,
} from "../server/src/risk";
import { riskFlipBody } from "../server/src/eventGateAlerts";
import type { ScanFeatures } from "../server/src/scan";

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

function etfPos(symbol: string, qty: number, avg = 100, gatedDuration = false): Position {
  return {
    id: gatedDuration ? `dur-${symbol}` : `etf-${symbol}`,
    symbol,
    root: null,
    qty,
    side: "Long",
    avgPrice: avg,
    unrealizedPnl: 0,
    gated: false,
    sleeveId: "riskoff",
    ...(gatedDuration ? { gatedDuration: true } : {}),
  };
}

function putLeg(underlying: string, strike: number): OptionLeg {
  return {
    underlying,
    osiKey: `O:${underlying}261016P${String(strike * 1000).padStart(8, "0")}`,
    displaySymbol: `${underlying} P ${strike}`,
    right: "P",
    strike,
    expiry: "2026-10-16",
    bid: 1,
    ask: 1.1,
    last: 1.05,
    bidSize: 10,
    askSize: 10,
    openInterest: 200,
    delta: -0.4,
    gamma: 0.01,
    theta: -0.02,
    vega: 0.1,
    iv: 0.2,
  };
}

function putPos(underlying: string): Position {
  const long = putLeg(underlying, 100);
  const short = putLeg(underlying, 95);
  return {
    id: `put-${underlying}`,
    symbol: `${underlying} 100/95 P`,
    root: null,
    qty: 1,
    side: "Long",
    avgPrice: 1,
    unrealizedPnl: 0,
    gated: false,
    sleeveId: "riskoff",
    vertical: {
      kind: "debit-vertical",
      right: "P",
      expiry: "2026-10-16",
      underlying,
      quoteSymbol: underlying,
      qty: 1,
      long,
      short,
      longFill: 1.1,
      shortFill: 0.1,
      netDebitPerShare: 1,
      netDebitPaid: 100,
      maxLoss: 100,
      maxProfit: 400,
      width: 5,
      openedAt: "2026-10-02T13:46:14Z",
      asOf: "2026-10-02T13:46:14Z",
    },
  };
}

function etfRs(overrides: Partial<Record<RiskoffEtfSymbol, number | null>>): RiskoffEtfReturns {
  const out = emptyRiskoffEtfReturns();
  for (const s of RISKOFF_ETF_SYMBOLS) out[s] = 0;
  out.BIL = 0.01;
  for (const [k, v] of Object.entries(overrides) as Array<[RiskoffEtfSymbol, number | null]>) {
    out[k] = v;
  }
  return out;
}

function etfAbove200(): RiskoffEtfAbove200 {
  const out = emptyRiskoffEtfAbove200();
  for (const s of RISKOFF_ETF_SYMBOLS) out[s] = s === "BIL" ? null : true;
  return out;
}

const quotes = RISKOFF_ETF_SYMBOLS.map((symbol) => ({
  symbol,
  last: symbol === "UUP" ? 28 : symbol === "BIL" ? 91 : symbol === "TLT" ? 90 : 50,
}));

/** FTLS leads on 63d but fails a missing 21d confirm. TLT is next and is HYG-only ineligible. UUP is the name that survives those gates. */
const ftlsThenTlt = etfRs({ FTLS: 0.3, TLT: 0.2, UUP: 0.05 });

const putQuotes = [
  { symbol: "SPY", last: 500 },
  { symbol: "QQQ", last: 400 },
  { symbol: "IWM", last: 200 },
  { symbol: "HYG", last: 77 },
  { symbol: "LQD", last: 110 },
  { symbol: "JNK", last: 95 },
];

const creditBelow = { hygAbove200: false, lqdAbove200: false, jnkAbove200: false };

beforeEach(() => {
  resetRiskCache();
  resetRiskoffEtfMissingBarsMisses();
  resetRiskoffOverlayRegime();
});

afterEach(() => {
  resetRiskCache();
  resetRiskoffEtfMissingBarsMisses();
  resetRiskoffOverlayRegime();
});

describe("missing SPY bars are not a below-200 regime", () => {
  it("(a) SPY missing and HYG below 200: no duration, no puts, HYG-only rules stay on", () => {
    expect(riskoffEquityPutsAllowed(false, null)).toBe(false);
    expect(decidePutVerticalIntents(putQuotes, [], defaultSleeves().riskoff, false, {
      spyAbove200: null,
      ...creditBelow,
    })).toEqual([]);
    expect(decideRiskoffPutSells([putPos("SPY"), putPos("HYG")], false, { spyAbove200: null, hygAbove200: false })).toEqual(
      [],
    );

    const duration = decideRiskoffDuration({
      riskOn: false,
      spyAbove200: null,
      dollarVeto: false,
      uup20dPct: 0.01,
      positions: [etfPos("TLT", 200, 90, true)],
      sleeve: defaultSleeves().riskoff,
      quotes,
    });
    expect(duration.buy).toBeNull();
    expect(duration.sells).toEqual([]);
    expect(duration.reason).toMatch(/missing spyAbove200/);

    expect(resolveRiskoffOverlayRegime(null, false)).toEqual({ spyAbove200: true, hygAbove200: false });
    resetRiskoffOverlayRegime();
    const overlay = decideRiskoffEtf({
      riskOn: false,
      spyAbove200: null,
      hygAbove200: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: ftlsThenTlt,
      quotes,
      above200: etfAbove200(),
    });
    expect(overlay.winners).toEqual(["UUP"]);
    expect(overlay.winners.some((s) => (RISKOFF_ETF_HYG_ONLY_INELIGIBLE as readonly string[]).includes(s))).toBe(
      false,
    );
    expect(overlay.buy?.symbol).toBe("UUP");
    expect(overlay.buy?.qty).toBe(
      sizeRiskoffEtfShares(28, DEFAULT_SLEEVE_EQUITY_USD, RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED),
    );
    expect(riskoffHygOnlyRiskOff(false, null, false)).toBe(false);
  });

  it("(b) full fallback (all four missing) does not arm the SPY-below book", () => {
    const fallback = riskOffFallback();
    expect(fallback.riskOn).toBe(false);
    expect(fallback.checks.spyAbove200).toBeNull();
    expect(fallback.checks.acwiAbove200).toBeNull();
    expect(fallback.checks.hygAbove200).toBeNull();
    expect(fallback.checks.uup20dPct).toBeNull();
    expect(fallback.checks.dollarVeto).toBe(true);
    expect(riskTooltip(fallback)).toMatch(/SPY 200dma missing/);
    expect(riskTooltip(fallback)).not.toMatch(/below 200dma/);
    expect(riskFlipBody(fallback)).toMatch(/SPY 200dma missing/);
    expect(riskFlipBody(fallback)).not.toMatch(/below 200dma/);

    expect(
      decidePutVerticalIntents(putQuotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: null,
        hygAbove200: null,
        lqdAbove200: null,
        jnkAbove200: null,
      }),
    ).toEqual([]);

    const duration = decideRiskoffDuration({
      riskOn: false,
      spyAbove200: null,
      dollarVeto: true,
      uup20dPct: null,
      positions: [etfPos("TLT", 200, 90, true)],
      sleeve: defaultSleeves().riskoff,
      quotes,
    });
    expect(duration.buy).toBeNull();
    expect(duration.sells).toEqual([]);

    const overlay = decideRiskoffEtf({
      riskOn: false,
      spyAbove200: null,
      hygAbove200: null,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: ftlsThenTlt,
      quotes,
      above200: etfAbove200(),
    });
    expect(overlay.winners).toEqual(["UUP"]);
    expect(overlay.buy?.qty).toBe(
      sizeRiskoffEtfShares(28, DEFAULT_SLEEVE_EQUITY_USD, RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED),
    );

    decideRiskoffEtf({
      riskOn: false,
      spyAbove200: true,
      hygAbove200: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: ftlsThenTlt,
      quotes,
      above200: etfAbove200(),
    });
    const held = decideRiskoffEtf({
      riskOn: false,
      spyAbove200: null,
      hygAbove200: null,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: ftlsThenTlt,
      quotes,
      above200: etfAbove200(),
    });
    expect(held.winners).toEqual(["UUP"]);
  });

  it("(c) a real SPY-below-200 print still arms duration and puts", () => {
    expect(riskoffEquityPutsAllowed(false, false)).toBe(true);
    const puts = decidePutVerticalIntents(putQuotes, [], defaultSleeves().riskoff, false, {
      spyAbove200: false,
      ...creditBelow,
    });
    expect(puts.map((p) => p.symbol)).toContain("HYG");
    expect(puts.length).toBeGreaterThan(0);

    const equityOnly = decidePutVerticalIntents(putQuotes, [], defaultSleeves().riskoff, false, {
      spyAbove200: false,
      hygAbove200: true,
      lqdAbove200: true,
      jnkAbove200: true,
    });
    expect(equityOnly.map((p) => p.symbol)).toContain("SPY");

    const duration = decideRiskoffDuration({
      riskOn: false,
      spyAbove200: false,
      dollarVeto: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      quotes,
    });
    expect(duration.buy?.symbol).toBe("TLT");
    expect(duration.buy?.gatedDuration).toBe(true);
    expect(duration.buy?.thesis).toMatch(/SPY below 200, dollar clear/);

    const overlay = decideRiskoffEtf({
      riskOn: false,
      spyAbove200: false,
      hygAbove200: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: ftlsThenTlt,
      quotes,
      above200: etfAbove200(),
    });
    expect(overlay.winners).toContain("FTLS");
    expect(overlay.winners).toContain("TLT");
  });

  it("(d) recovery after a miss does not sell and rebuy duration or the overlay", () => {
    const qty60 = sizeRiskoffEtfShares(28, DEFAULT_SLEEVE_EQUITY_USD, RISKOFF_ETF_NOTIONAL_FRAC_PUT_GATED);
    const opened = decideRiskoffEtf({
      riskOn: false,
      spyAbove200: true,
      hygAbove200: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: ftlsThenTlt,
      quotes,
      above200: etfAbove200(),
    });
    expect(opened.winners).toEqual(["UUP"]);
    expect(opened.buy?.qty).toBe(qty60);

    const heldUup = [etfPos("UUP", qty60, 28)];
    const during = decideRiskoffEtf({
      riskOn: false,
      spyAbove200: null,
      hygAbove200: false,
      positions: heldUup,
      sleeve: defaultSleeves().riskoff,
      returns: ftlsThenTlt,
      quotes,
      above200: etfAbove200(),
    });
    expect(during.winners).toEqual(["UUP"]);
    expect(during.sells).toEqual([]);
    expect(during.buy).toBeNull();

    const recovered = decideRiskoffEtf({
      riskOn: false,
      spyAbove200: true,
      hygAbove200: false,
      positions: heldUup,
      sleeve: defaultSleeves().riskoff,
      returns: ftlsThenTlt,
      quotes,
      above200: etfAbove200(),
    });
    expect(recovered.winners).toEqual(["UUP"]);
    expect(recovered.sells).toEqual([]);
    expect(recovered.buy).toBeNull();

    const bought = decideRiskoffDuration({
      riskOn: false,
      spyAbove200: false,
      dollarVeto: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      quotes,
    });
    expect(bought.buy?.symbol).toBe("TLT");
    const lot = [etfPos("TLT", bought.buy?.qty ?? 0, 90, true)];

    const missed = decideRiskoffDuration({
      riskOn: false,
      spyAbove200: null,
      dollarVeto: false,
      uup20dPct: 0.01,
      positions: lot,
      sleeve: defaultSleeves().riskoff,
      quotes,
    });
    expect(missed.sells).toEqual([]);
    expect(missed.buy).toBeNull();

    const stillBelow = decideRiskoffDuration({
      riskOn: false,
      spyAbove200: false,
      dollarVeto: false,
      positions: lot,
      sleeve: defaultSleeves().riskoff,
      quotes,
    });
    expect(stillBelow.reason).toMatch(/hold TLT/);
    expect(stillBelow.sells).toEqual([]);
    expect(stillBelow.buy).toBeNull();

    const flat = decideRiskoffDuration({
      riskOn: false,
      spyAbove200: null,
      dollarVeto: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      quotes,
    });
    expect(flat.buy).toBeNull();
    const stillFlat = decideRiskoffDuration({
      riskOn: false,
      spyAbove200: true,
      dollarVeto: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      quotes,
    });
    expect(stillFlat.buy).toBeNull();
    expect(stillFlat.sells).toEqual([]);
  });

  it("a single SPY miss after a real above-200 read is carried, not reported as below", () => {
    const good = riskFromFeatures({
      spy: feat(true),
      acwi: feat(true),
      hyg: feat(false),
      uup20dPct: 0.01,
    });
    applyAbove200Staleness(good);
    const missed = applyAbove200Staleness(
      riskFromFeatures({
        spy: null,
        acwi: feat(true),
        hyg: feat(false),
        uup20dPct: 0.01,
      }),
    );
    expect(missed.checks.spyAbove200).toBe(true);
    expect(missed.riskOn).toBe(false);
    expect(riskTooltip(missed)).not.toMatch(/SPY below 200dma/);
    expect(riskTooltip(missed)).toMatch(/HYG below 200dma/);

    const duration = decideRiskoffDuration({
      riskOn: missed.riskOn,
      spyAbove200: missed.checks.spyAbove200,
      dollarVeto: missed.checks.dollarVeto,
      uup20dPct: missed.checks.uup20dPct,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      quotes,
    });
    expect(duration.buy).toBeNull();
    expect(duration.reason).toMatch(/SPY above 200dma/);
  });
});
