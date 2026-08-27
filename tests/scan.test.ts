import { afterEach, describe, expect, it, vi } from "vitest";
import {
  featuresFromBars,
  momentumScore,
  parseConstituentsCsv,
  passesMomentumFilter,
  passesOwnershipFilter,
  rankMomentum,
  rankOwnership,
  resetScanCache,
  yahooEquityTicker,
  type DailyBar,
  type FeatureRow,
  type ScanFeatures,
} from "../server/src/scan";

afterEach(() => {
  resetScanCache();
  vi.unstubAllGlobals();
});

function feat(partial: Partial<ScanFeatures> & Pick<ScanFeatures, "last">): ScanFeatures {
  return {
    sma20: partial.last,
    sma200: partial.last * 0.9,
    high52: partial.last,
    pctFrom52: 0,
    dist20: 0,
    above200: true,
    ret63: 0.1,
    ret126: 0.2,
    ret252: 0.3,
    has252: true,
    volx: 1,
    ...partial,
  };
}

function row(
  symbol: string,
  sector: string,
  f: ScanFeatures,
  name = symbol,
): FeatureRow {
  return { symbol, name, sector, features: f };
}

describe("yahooEquityTicker", () => {
  it("maps BRK.B and BF.B to Yahoo dash tickers", () => {
    expect(yahooEquityTicker("BRK.B")).toBe("BRK-B");
    expect(yahooEquityTicker("brk.b")).toBe("BRK-B");
    expect(yahooEquityTicker("BF.B")).toBe("BF-B");
  });

  it("skips other dotted symbols Yahoo hates", () => {
    expect(yahooEquityTicker("BF.A")).toBeNull();
    expect(yahooEquityTicker("BRK.A")).toBeNull();
    expect(yahooEquityTicker("XXX.Y")).toBeNull();
  });

  it("keeps plain large-cap tickers", () => {
    expect(yahooEquityTicker("AAPL")).toBe("AAPL");
    expect(yahooEquityTicker(" spy ")).toBe("SPY");
  });
});

describe("parseConstituentsCsv", () => {
  it("reads Symbol / Security / GICS Sector and maps dotted class-B names", () => {
    const csv = [
      "Symbol,Security,GICS Sector,GICS Sub-Industry",
      "AAPL,Apple Inc.,Information Technology,Tech",
      'BRK.B,Berkshire Hathaway,Financials,"Multi-Sector Holdings"',
      "BF.B,Brown-Forman,Consumer Staples,Distillers",
      "NOPE.X,Skip Me,Energy,Oil",
    ].join("\n");
    const names = parseConstituentsCsv(csv);
    expect(names.map((n) => n.yahoo)).toEqual(["AAPL", "BRK-B", "BF-B"]);
    expect(names.find((n) => n.yahoo === "BRK-B")).toMatchObject({
      symbol: "BRK.B",
      sector: "Financials",
      name: "Berkshire Hathaway",
    });
    expect(names.some((n) => n.symbol.includes("NOPE"))).toBe(false);
  });
});

function barsFromCloses(closes: number[], vol = 1_000_000): DailyBar[] {
  return closes.map((close) => ({ close, volume: vol }));
}

describe("featuresFromBars (no fake prices)", () => {
  it("returns null below 200 closes rather than inventing SMA", () => {
    const closes = Array.from({ length: 199 }, () => 100);
    expect(featuresFromBars(barsFromCloses(closes))).toBeNull();
  });

  it("computes last / SMA / 52w / dist20 / volx from fixture bars only", () => {
    const closes = Array.from({ length: 220 }, (_, i) => 90 + i * 0.05);
    closes[closes.length - 1] = 102;
    const vols = closes.map((_, i) => (i === closes.length - 1 ? 2_000_000 : 1_000_000));
    const bars = closes.map((close, i) => ({ close, volume: vols[i] }));
    const f = featuresFromBars(bars);
    expect(f).not.toBeNull();
    expect(f!.last).toBe(102);
    expect(f!.sma20).toBeCloseTo(
      closes.slice(-20).reduce((a, b) => a + b, 0) / 20,
      10,
    );
    expect(f!.sma200).toBeCloseTo(
      closes.slice(-200).reduce((a, b) => a + b, 0) / 200,
      10,
    );
    expect(f!.high52).toBe(102);
    expect(f!.above200).toBe(true);
    expect(f!.volx).toBeCloseTo(2_000_000 / ((19 * 1_000_000 + 2_000_000) / 20), 10);
    expect(f!.has252).toBe(false);
  });

  it("does not call fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    featuresFromBars(barsFromCloses(Array.from({ length: 200 }, () => 50)));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("momentum filter", () => {
  it("rejects extended names with dist20 > 3%", () => {
    const extended = feat({ last: 100, dist20: 0.031, pctFrom52: 0, above200: true });
    expect(passesMomentumFilter(extended)).toBe(false);
    const inBand = feat({ last: 100, dist20: 0.02, pctFrom52: -0.05, above200: true });
    expect(passesMomentumFilter(inBand)).toBe(true);
    const tooDeep = feat({ last: 100, dist20: -0.041, pctFrom52: 0, above200: true });
    expect(passesMomentumFilter(tooDeep)).toBe(false);
    const off52 = feat({ last: 100, dist20: 0, pctFrom52: -0.11, above200: true });
    expect(passesMomentumFilter(off52)).toBe(false);
    const below200 = feat({ last: 100, dist20: 0, pctFrom52: 0, above200: false });
    expect(passesMomentumFilter(below200)).toBe(false);
  });
});

describe("ownership filter", () => {
  it("requires an uptrend (3/6/12m when 252 exists)", () => {
    const up = feat({ last: 100, ret63: 0.05, ret126: 0.1, ret252: 0.2, has252: true });
    expect(passesOwnershipFilter(up)).toBe(true);
    const down3m = feat({ last: 100, ret63: -0.01, ret126: 0.1, ret252: 0.2, has252: true });
    expect(passesOwnershipFilter(down3m)).toBe(false);
    const below200 = feat({
      last: 100,
      above200: false,
      ret63: 0.05,
      ret126: 0.1,
      ret252: 0.2,
      has252: true,
    });
    expect(passesOwnershipFilter(below200)).toBe(false);
  });

  it("allows 2 of 3 when 252 lookback is missing", () => {
    const two = feat({
      last: 100,
      ret63: 0.05,
      ret126: 0.08,
      ret252: null,
      has252: false,
    });
    expect(passesOwnershipFilter(two)).toBe(true);
    const one = feat({
      last: 100,
      ret63: 0.05,
      ret126: -0.01,
      ret252: null,
      has252: false,
    });
    expect(passesOwnershipFilter(one)).toBe(false);
  });
});

describe("ranking", () => {
  it("keeps one name per GICS sector on momentum (highest score)", () => {
    const a = row(
      "AAPL",
      "Information Technology",
      feat({ last: 100, dist20: 0, ret63: 0.2, ret252: 0.4, volx: 1 }),
    );
    const b = row(
      "MSFT",
      "Information Technology",
      feat({ last: 100, dist20: 0, ret63: 0.1, ret252: 0.2, volx: 1 }),
    );
    const c = row(
      "JPM",
      "Financials",
      feat({ last: 80, dist20: 0.01, ret63: 0.15, ret252: 0.25, volx: 1 }),
    );
    const ranked = rankMomentum([a, b, c], 0, 0);
    expect(ranked.map((r) => r.symbol)).toEqual(["AAPL", "JPM"]);
    expect(new Set(ranked.map((r) => r.sector)).size).toBe(ranked.length);
  });

  it("caps ownership at 2 per sector and ranks by ret252", () => {
    const tech = ["A", "B", "C"].map((s, i) =>
      row(
        s,
        "Information Technology",
        feat({ last: 100, ret63: 0.05, ret126: 0.1, ret252: 0.5 - i * 0.1 }),
      ),
    );
    const fin = ["D", "E"].map((s, i) =>
      row(
        s,
        "Financials",
        feat({ last: 50, ret63: 0.05, ret126: 0.1, ret252: 0.2 - i * 0.01 }),
      ),
    );
    const ranked = rankOwnership([...tech, ...fin], 0);
    expect(ranked.map((r) => r.symbol)).toEqual(["A", "B", "D", "E"]);
    const techN = ranked.filter((r) => r.sector === "Information Technology");
    expect(techN).toHaveLength(2);
  });

  it("scorer is a pure function on fixture features — never fetches or invents last", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const f = feat({ last: 100, ret63: 0.12, ret252: 0.2, volx: 1.5 });
    const score = momentumScore(f, 0.02, 0.08);
    // rs3m 0.10 + 0.25 * rs12m 0.12 + 0.01 * 0.5 volx bonus
    expect(score).toBeCloseTo(0.1 + 0.25 * 0.12 + 0.005, 10);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(f.last).toBe(100);
  });
});
