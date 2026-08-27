import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSleeves } from "../shared/types";
import {
  fetchDelayedQuotes,
  mapTicker,
  parseInstrumentTickers,
  resetQuoteCache,
  symbolsForSleeve,
  YAHOO_CHART_BASE,
  YAHOO_UA,
} from "../server/src/quotes";

function yahooBody(
  symbol: string,
  last: number,
  prev: number,
  t = 1_787_847_253,
) {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            regularMarketPrice: last,
            previousClose: prev,
            chartPreviousClose: prev,
            regularMarketTime: t,
            exchangeName: "CME",
            instrumentType: "FUTURE",
          },
        },
      ],
      error: null,
    },
  };
}

describe("mapTicker / parseInstrumentTickers", () => {
  it("maps futures roots to Yahoo =F tickers", () => {
    expect(mapTicker("MES")).toBe("MES=F");
    expect(mapTicker("mes")).toBe("MES=F");
    expect(mapTicker("ZN")).toBe("ZN=F");
    expect(mapTicker("M6E")).toBe("M6E=F");
    expect(mapTicker("6E")).toBe("6E=F");
    expect(mapTicker("SR3")).toBe("SR3=F");
    expect(mapTicker("ES")).toBe("ES=F");
    expect(mapTicker("NQ")).toBe("NQ=F");
  });

  it("keeps already-suffixed and equity tickers", () => {
    expect(mapTicker("MES=F")).toBe("MES=F");
    expect(mapTicker("SPY")).toBe("SPY");
    expect(mapTicker("AAPL")).toBe("AAPL");
    expect(mapTicker("QQQ")).toBe("QQQ");
    expect(mapTicker("")).toBeNull();
  });

  it("parses MES / ZN / M6E / SR3 from the day sleeve instruments string", () => {
    expect(parseInstrumentTickers("MES / ZN / M6E / SR3")).toEqual([
      "MES=F",
      "ZN=F",
      "M6E=F",
      "SR3=F",
    ]);
    expect(parseInstrumentTickers("SPY, QQQ, IWM")).toEqual(["SPY", "QQQ", "IWM"]);
  });

  it("uses sleeve.instruments when non-empty, else sleeve defaults", () => {
    const sleeves = defaultSleeves();
    expect(symbolsForSleeve(sleeves.day, "day")).toEqual([
      "MES=F",
      "ZN=F",
      "M6E=F",
      "SR3=F",
    ]);
    expect(symbolsForSleeve(sleeves.momentum, "momentum")).toEqual([
      "MES=F",
      "ES=F",
      "SPY",
      "QQQ",
      "TLT",
    ]);
    expect(symbolsForSleeve(sleeves.options, "options")).toEqual(["SPY", "QQQ", "IWM"]);
    expect(symbolsForSleeve(sleeves.ownership, "ownership")).toEqual([
      "SPY",
      "QQQ",
      "TLT",
      "IWM",
    ]);
    sleeves.momentum.instruments = "ES, NQ, SPY";
    expect(symbolsForSleeve(sleeves.momentum, "momentum")).toEqual(["ES=F", "NQ=F", "SPY"]);
  });
});

describe("fetchDelayedQuotes", () => {
  beforeEach(() => {
    resetQuoteCache();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        expect(url).toContain("/v8/finance/chart/");
        expect(url).not.toContain("/v7/finance/quote");
        const after = url.slice(url.indexOf("/chart/") + "/chart/".length);
        const encoded = after.split("?")[0];
        const symbol = decodeURIComponent(encoded);
        return {
          ok: true,
          status: 200,
          json: async () => yahooBody(symbol, 100, 90),
        };
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("parses chart meta and labels DELAYED / yahoo", async () => {
    const quotes = await fetchDelayedQuotes(["MES"]);
    expect(quotes).toHaveLength(1);
    expect(quotes[0].symbol).toBe("MES=F");
    expect(quotes[0].last).toBe(100);
    expect(quotes[0].prevClose).toBe(90);
    expect(quotes[0].change).toBe(10);
    expect(quotes[0].changePct).toBeCloseTo(100 / 9, 5);
    expect(quotes[0].delayed).toBe(true);
    expect(quotes[0].source).toBe("yahoo");
    expect(quotes[0].exchange).toBe("CME");
    expect(quotes[0].asOf).toBe(new Date(1_787_847_253 * 1000).toISOString());
    expect(quotes[0].error).toBeUndefined();
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(`${YAHOO_CHART_BASE}${encodeURIComponent("MES=F")}?interval=5m&range=1d`);
    expect((init as RequestInit).headers).toEqual({ "User-Agent": YAHOO_UA });
  });

  it("caches for 45s and does not re-hit Yahoo", async () => {
    await fetchDelayedQuotes(["SPY"]);
    await fetchDelayedQuotes(["SPY"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns { symbol, error } with null last — never invents a price", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        json: async () => ({ chart: { result: null, error: { description: "Unauthorized" } } }),
      })),
    );
    const quotes = await fetchDelayedQuotes(["NOPE"]);
    expect(quotes[0]).toMatchObject({
      symbol: "NOPE",
      last: null,
      prevClose: null,
      change: null,
      changePct: null,
      delayed: true,
      source: "yahoo",
      error: "http 401",
    });
    expect(quotes[0].last).toBeNull();
  });

  it("does not fabricate last when chart.result is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ chart: { result: [], error: null } }),
      })),
    );
    const quotes = await fetchDelayedQuotes(["ZZZ"]);
    expect(quotes[0].last).toBeNull();
    expect(quotes[0].error).toBe("no chart result");
  });
});
