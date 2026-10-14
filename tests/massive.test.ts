import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cpiLateFadeSignal } from "../server/src/cpiLateFade";
import {
  fetchCpiLateFadeMesFiveMinuteBars,
  fetchDayMesFiveMinuteBars,
  fetchDelayedQuotes,
  isYahooFuturesSymbol,
  mapTicker,
  resetQuoteCache,
} from "../server/src/quotes";
import {
  MASSIVE_KEY_MISSING,
  inferExpiryType,
  massiveFuturesProductCode,
  parseMassiveDailyBars,
  parseMassiveFuturesAggs,
  parseMassiveFuturesContracts,
  parseMassiveOptionChain,
  parseMassiveSnapshotQuote,
  parseOptionsUnderlying,
  pickFrontMonthContract,
  resetMassiveCache,
} from "../server/src/massive";
import { pickAtmCallDebit, pickTargetExpiry } from "../server/src/autopilot";
import { decideDayMomentum } from "../server/src/dayMomentum";
import { zonedTimeToUtc } from "../shared/clock";
import {
  MASSIVE_TEST_KEY,
  clearMassiveTestKey,
  fiveMinuteBars,
  massiveAggsBody,
  massiveChainBodiesFromEtrade,
  massiveFuturesAggsBody,
  massiveSnapshotBody,
  setMassiveTestKey,
  stubMarketFetch,
} from "./helpers/massiveStub";

afterEach(() => {
  vi.useRealTimers();
  clearMassiveTestKey();
  resetQuoteCache();
  resetMassiveCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseOptionsUnderlying", () => {
  it("accepts AAPL and SPCX", () => {
    expect(parseOptionsUnderlying("AAPL")).toEqual({ ok: true, symbol: "AAPL" });
    expect(parseOptionsUnderlying("spcx")).toEqual({ ok: true, symbol: "SPCX" });
    expect(parseOptionsUnderlying("BRK.B")).toEqual({ ok: true, symbol: "BRK.B" });
  });

  it("rejects empty, futures, and OSI keys", () => {
    expect(parseOptionsUnderlying("").ok).toBe(false);
    expect(parseOptionsUnderlying("MES=F").ok).toBe(false);
    expect(parseOptionsUnderlying("MES=F").ok === false && parseOptionsUnderlying("MES=F").error).toMatch(/futures/i);
    expect(parseOptionsUnderlying("O:AAPL230616C00150000").ok).toBe(false);
    expect(parseOptionsUnderlying("AAPL230616C00150000").ok).toBe(false);
  });
});

describe("Massive parsers", () => {
  it("maps a stock snapshot to DelayedQuote delayed/massive", () => {
    const q = parseMassiveSnapshotQuote("AAPL", massiveSnapshotBody("AAPL", 190, 188));
    expect(q.delayed).toBe(true);
    expect(q.source).toBe("massive");
    expect(q.last).toBe(190);
    expect(q.prevClose).toBe(188);
    expect(q.change).toBe(2);
    expect(q.error).toBeUndefined();
  });

  it("does not invent last when snapshot has no trade/close", () => {
    const q = parseMassiveSnapshotQuote("ZZZ", { status: "OK", ticker: { ticker: "ZZZ" } });
    expect(q.last).toBeNull();
    expect(q.error).toMatch(/no last/i);
  });

  it("parses adjusted daily aggs to close/volume bars", () => {
    const bars = parseMassiveDailyBars(massiveAggsBody([10, 11, 12], 50));
    expect(bars).toEqual([
      { close: 10, volume: 50 },
      { close: 11, volume: 50 },
      { close: 12, volume: 50 },
    ]);
  });

  it("maps option snapshot results to OptionLeg bid/ask (nulls stay null)", () => {
    const { calls, puts } = massiveChainBodiesFromEtrade();
    const snap = parseMassiveOptionChain([calls, puts], "SPY", "2013-03-16");
    expect(snap.source).toBe("massive");
    expect(snap.delayed).toBe(true);
    const c65 = snap.legs.find((l) => l.right === "C" && l.strike === 65);
    expect(c65?.ask).toBe(5.2);
    expect(c65?.bid).toBe(5.1);
    const missing = parseMassiveOptionChain(
      [{ status: "OK", results: [{ details: { contract_type: "call", expiration_date: "2013-03-16", strike_price: 100, ticker: "O:X" } }] }],
      "SPY",
      "2013-03-16",
    );
    expect(missing.legs[0].bid).toBeNull();
    expect(missing.legs[0].ask).toBeNull();
  });
});

describe("inferExpiryType", () => {
  it("tags 2013-03-16 monthly and 2013-03-22 weekly", () => {
    expect(inferExpiryType("2013-03-16")).toBe("MONTHLY");
    expect(inferExpiryType("2013-03-22")).toBe("WEEKLY");
    expect(inferExpiryType("2013-04-19")).toBe("MONTHLY");
  });
});

describe("isYahooFuturesSymbol", () => {
  it("classifies MES=F as futures and AAPL as equities", () => {
    expect(isYahooFuturesSymbol("MES=F")).toBe(true);
    expect(isYahooFuturesSymbol(mapTicker("MES")!)).toBe(true);
    expect(isYahooFuturesSymbol("AAPL")).toBe(false);
    expect(isYahooFuturesSymbol("SPY")).toBe(false);
  });
});

describe("Massive futures product / front-month", () => {
  it("maps MES=F, F:MES, and roots to Massive product codes; unknown =F stays unmapped", () => {
    expect(massiveFuturesProductCode("MES=F")).toBe("MES");
    expect(massiveFuturesProductCode("F:MES")).toBe("MES");
    expect(massiveFuturesProductCode("mes")).toBe("MES");
    expect(massiveFuturesProductCode("ZN=F")).toBe("ZN");
    expect(massiveFuturesProductCode("M6E=F")).toBe("M6E");
    expect(massiveFuturesProductCode("SR3=F")).toBe("SR3");
    expect(massiveFuturesProductCode("NOPE=F")).toBeNull();
    expect(massiveFuturesProductCode("SPY")).toBeNull();
  });

  it("picks the nearest active single and skips combos / expired", () => {
    const rows = parseMassiveFuturesContracts({
      results: [
        { ticker: "MESU6-MESZ6", product_code: "MES", active: true, type: "combo", days_to_maturity: 5 },
        { ticker: "MESH6", product_code: "MES", active: true, type: "single", days_to_maturity: -2 },
        { ticker: "MESZ6", product_code: "MES", active: true, type: "single", days_to_maturity: 90 },
        { ticker: "MESU6", product_code: "MES", active: true, type: "single", days_to_maturity: 20 },
      ],
    });
    expect(pickFrontMonthContract(rows)?.ticker).toBe("MESU6");
  });

  it("rolls off expired MESU6 to MESZ6 as of 2026-10-14", () => {
    const rows = parseMassiveFuturesContracts({
      results: [
        {
          ticker: "MESU6",
          product_code: "MES",
          active: true,
          type: "single",
          days_to_maturity: 2,
          last_trade_date: "2026-09-18",
          settlement_date: "2026-09-18",
        },
        {
          ticker: "MESZ6",
          product_code: "MES",
          active: true,
          type: "single",
          days_to_maturity: 65,
          last_trade_date: "2026-12-18",
          settlement_date: "2026-12-18",
        },
        {
          ticker: "MESH7",
          product_code: "MES",
          active: true,
          type: "single",
          days_to_maturity: 156,
          last_trade_date: "2027-03-19",
        },
        {
          ticker: "MESU6-MESZ6",
          product_code: "MES",
          active: true,
          type: "combo",
          days_to_maturity: 1,
        },
      ],
    });
    expect(pickFrontMonthContract(rows, "2026-10-14")?.ticker).toBe("MESZ6");
    const negative = parseMassiveFuturesContracts({
      results: [
        { ticker: "MESU6", product_code: "MES", active: true, type: "single", days_to_maturity: -26 },
        { ticker: "MESZ6", product_code: "MES", active: true, type: "single", days_to_maturity: 65 },
      ],
    });
    expect(pickFrontMonthContract(negative, "2026-10-14")?.ticker).toBe("MESZ6");
  });

  it("parses futures 5m aggs window_start nanoseconds and does not invent OHLC", () => {
    const ts = Date.UTC(2026, 8, 2, 13, 30, 0);
    const bars = parseMassiveFuturesAggs(
      massiveFuturesAggsBody("MESU6", [
        { ts, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 },
        { ts: ts + 300_000, open: 2, high: 3, low: 1, close: 2.5, volume: 20 },
      ]),
    );
    expect(bars).toHaveLength(2);
    expect(bars[1].close).toBe(2.5);
    expect(bars[1].ts).toBe(ts + 300_000);
    expect(parseMassiveFuturesAggs({ status: "OK", results: [{ ticker: "MESU6" }] })).toEqual([]);
  });
});

describe("fetchDelayedQuotes Massive vs Yahoo", () => {
  beforeEach(() => {
    resetQuoteCache();
    resetMassiveCache();
  });

  it("uses Massive Futures snapshot for MES and Massive Stocks for SPY when the key is set", async () => {
    setMassiveTestKey();
    stubMarketFetch({ lastBySymbol: { "MES=F": 5800, SPY: 500 } });
    const quotes = await fetchDelayedQuotes(["MES", "SPY"]);
    const mes = quotes.find((q) => q.symbol === "MES=F");
    const spy = quotes.find((q) => q.symbol === "SPY");
    expect(mes?.source).toBe("massive");
    expect(mes?.last).toBe(5800);
    expect(spy?.source).toBe("massive");
    expect(spy?.last).toBe(500);
    expect(spy?.delayed).toBe(true);
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/futures/v1/contracts") && u.includes("product_code=MES"))).toBe(true);
    expect(urls.some((u) => u.includes("/futures/v1/snapshot") && u.includes("MES"))).toBe(true);
    expect(urls.some((u) => u.includes("/v2/snapshot/locale/us/markets/stocks/tickers/SPY"))).toBe(true);
    expect(urls.every((u) => !u.includes("/v8/finance/chart/"))).toBe(true);
    expect(urls.every((u) => !/apiKey=/i.test(u))).toBe(true);
    expect(MASSIVE_TEST_KEY).toBeTruthy();
  });

  it("falls back to Yahoo futures last when Massive Futures errors", async () => {
    setMassiveTestKey();
    stubMarketFetch({ lastBySymbol: { "MES=F": 5800, SPY: 500 }, futuresStatus: 503 });
    const quotes = await fetchDelayedQuotes(["MES", "SPY"]);
    const mes = quotes.find((q) => q.symbol === "MES=F");
    const spy = quotes.find((q) => q.symbol === "SPY");
    expect(mes?.source).toBe("yahoo");
    expect(mes?.last).toBe(5800);
    expect(spy?.source).toBe("massive");
    expect(spy?.last).toBe(500);
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/futures/v1/"))).toBe(true);
    expect(urls.some((u) => u.includes("/v8/finance/chart/") && u.includes("MES"))).toBe(true);
  });

  it("boots equity path with a clear error when MASSIVE_API_KEY is missing; futures still Yahoo", async () => {
    clearMassiveTestKey();
    stubMarketFetch({ lastBySymbol: { "MES=F": 5800 } });
    const quotes = await fetchDelayedQuotes(["MES", "SPY"]);
    const mes = quotes.find((q) => q.symbol === "MES=F");
    const spy = quotes.find((q) => q.symbol === "SPY");
    expect(mes?.source).toBe("yahoo");
    expect(mes?.last).toBe(5800);
    expect(spy?.source).toBe("massive");
    expect(spy?.last).toBeNull();
    expect(spy?.error).toBe(MASSIVE_KEY_MISSING);
  });
});

describe("fetchDayMesFiveMinuteBars Massive vs Yahoo", () => {
  beforeEach(() => {
    resetQuoteCache();
    resetMassiveCache();
  });

  it("uses Massive Futures 5m aggs when the key is set and the response is valid", async () => {
    setMassiveTestKey();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    stubMarketFetch({
      lastBySymbol: { "MES=F": 5900 },
      futuresAggs: fiveMinuteBars(22, 5900),
    });
    const bars = await fetchDayMesFiveMinuteBars();
    expect(bars).toHaveLength(22);
    expect(bars[0].close).toBe(5900);
    expect(bars[0].ts).toBeGreaterThan(0);
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/futures/v1/contracts") && u.includes("product_code=MES"))).toBe(true);
    expect(urls.some((u) => u.includes("/futures/v1/aggs/") && u.includes("5min"))).toBe(true);
    expect(urls.every((u) => !u.includes("/v8/finance/chart/"))).toBe(true);
    expect(info.mock.calls.some((c) => String(c[0]).includes("source=massive"))).toBe(true);
    info.mockRestore();
  });

  it("falls back to Yahoo 5m MES=F when Massive Futures errors", async () => {
    setMassiveTestKey();
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    stubMarketFetch({
      lastBySymbol: { "MES=F": 5700 },
      futuresStatus: 502,
      yahooFiveMinuteBars: fiveMinuteBars(20, 5700),
    });
    const bars = await fetchDayMesFiveMinuteBars();
    expect(bars).toHaveLength(20);
    expect(bars[0].close).toBe(5700);
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/futures/v1/"))).toBe(true);
    expect(urls.some((u) => u.includes("/v8/finance/chart/") && u.includes("MES"))).toBe(true);
    expect(info.mock.calls.some((c) => String(c[0]).includes("source=yahoo"))).toBe(true);
    info.mockRestore();
  });

  it("still feeds decideDayMomentum from Massive-parsed 5m bars", async () => {
    setMassiveTestKey();
    const raw = fiveMinuteBars(22, 81).map((b) => ({ ...b, high: 100, low: 80 }));
    raw[21] = { ...raw[21], close: 99, high: 100, low: 80 };
    stubMarketFetch({ futuresAggs: raw });
    const bars = await fetchDayMesFiveMinuteBars();
    const noon = zonedTimeToUtc(2026, 9, 2, 11, 20, 0);
    const got = decideDayMomentum({
      now: noon,
      gateMode: "idle",
      bars,
      positions: [],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      knowledgeTime: zonedTimeToUtc(2026, 9, 2, 8, 35, 0).toISOString(),
      events: [
        {
          id: "nfp-2026-09-02",
          timeUtc: zonedTimeToUtc(2026, 9, 2, 8, 30, 0).toISOString(),
          type: "NFP",
          flattenEt: "15:45",
        },
      ],
    });
    expect(got.buy?.side).toBe("Buy");
    expect(got.buy?.symbol).toBe("MES=F");
    expect(got.buy?.qty).toBe(1);
  });
});

function ohlc(ts: number, close: number) {
  return { ts, open: close, high: close + 1, low: close - 1, close, volume: 1000 };
}

describe("cpiLateFade bar window vs the stochastic series", () => {
  it("Yahoo fallback uses range=5d so the prior 16:00 ET bar is present", async () => {
    clearMassiveTestKey();
    const prior = zonedTimeToUtc(2026, 10, 13, 15, 55, 0).getTime();
    const todayOnly = [
      ohlc(zonedTimeToUtc(2026, 10, 14, 0, 5, 0).getTime(), 100),
      ohlc(zonedTimeToUtc(2026, 10, 14, 10, 25, 0).getTime(), 110),
      ohlc(zonedTimeToUtc(2026, 10, 14, 15, 25, 0).getTime(), 111),
    ];
    const now = zonedTimeToUtc(2026, 10, 14, 15, 30, 0);
    const oneDay = cpiLateFadeSignal(now, todayOnly);
    expect(oneDay.ok).toBe(false);
    if (!oneDay.ok) expect(oneDay.reason).toBe("missing MES 5m prior close");

    stubMarketFetch({
      yahooBarsByRange: {
        "5d": [ohlc(prior, 100), ...todayOnly],
      },
    });
    const day = await fetchDayMesFiveMinuteBars();
    const fade = await fetchCpiLateFadeMesFiveMinuteBars();
    for (const series of [day, fade]) {
      const got = cpiLateFadeSignal(now, series);
      expect(got.ok).toBe(true);
      if (got.ok) {
        expect(got.priorClose).toBe(100);
        expect(got.moveSign).toBe(1);
      }
    }
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.filter((u) => u.includes("/v8/finance/chart/")).every((u) => u.includes("range=5d"))).toBe(true);
    expect(urls.some((u) => u.includes("range=1d"))).toBe(false);
    expect(urls.some((u) => u.includes("/futures/v1/aggs/"))).toBe(false);
  });

  it("asks Massive for the ET-date front month and does not keep expired MESU6", async () => {
    setMassiveTestKey();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(zonedTimeToUtc(2026, 10, 14, 15, 30, 0));
    stubMarketFetch({
      futuresContracts: {
        status: "OK",
        results: [
          {
            ticker: "MESU6",
            product_code: "MES",
            active: true,
            type: "single",
            days_to_maturity: -26,
            last_trade_date: "2026-09-18",
            settlement_date: "2026-09-18",
          },
          {
            ticker: "MESZ6",
            product_code: "MES",
            active: true,
            type: "single",
            days_to_maturity: 65,
            last_trade_date: "2026-12-18",
            settlement_date: "2026-12-18",
          },
        ],
      },
      futuresAggs: fiveMinuteBars(4, 5800),
    });
    const bars = await fetchDayMesFiveMinuteBars();
    expect(bars.length).toBeGreaterThan(0);
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    const contracts = urls.find((u) => u.includes("/futures/v1/contracts"));
    expect(contracts).toBeTruthy();
    const q = new URL(contracts!);
    expect(q.searchParams.get("product_code")).toBe("MES");
    expect(q.searchParams.get("date")).toBe("2026-10-14");
    expect(q.searchParams.get("active")).toBe("true");
    expect(q.searchParams.get("type")).toBe("single");
    expect(q.searchParams.get("last_trade_date.gte")).toBe("2026-10-14");
    expect(q.searchParams.get("sort")).toBe("days_to_maturity.asc");
    const aggs = urls.find((u) => u.includes("/futures/v1/aggs/"));
    expect(aggs).toContain("MESZ6");
    expect(urls.some((u) => u.includes("/v8/finance/chart/"))).toBe(false);
  });

  it("keeps Massive day aggs at 2d oldest-first and covers the prior session on the fade query", async () => {
    setMassiveTestKey();
    const monday = zonedTimeToUtc(2026, 10, 12, 15, 30, 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(monday);
    const friday = zonedTimeToUtc(2026, 10, 9, 15, 55, 0).getTime();
    const todayOnly = [
      ohlc(zonedTimeToUtc(2026, 10, 12, 0, 5, 0).getTime(), 100),
      ohlc(zonedTimeToUtc(2026, 10, 12, 10, 25, 0).getTime(), 110),
      ohlc(zonedTimeToUtc(2026, 10, 12, 15, 25, 0).getTime(), 111),
    ];
    stubMarketFetch({
      futuresAggsBySort: {
        asc: todayOnly,
        desc: [ohlc(friday, 100), ...todayOnly],
      },
    });
    const day = await fetchDayMesFiveMinuteBars();
    const fade = await fetchCpiLateFadeMesFiveMinuteBars();
    const missing = cpiLateFadeSignal(monday, day);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("missing MES 5m prior close");
    const got = cpiLateFadeSignal(monday, fade);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.priorClose).toBe(100);

    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    const dayUrl = urls.find((u) => u.includes("/futures/v1/aggs/") && u.includes("sort=window_start.asc"));
    const fadeUrl = urls.find((u) => u.includes("/futures/v1/aggs/") && u.includes("sort=window_start.desc"));
    expect(dayUrl).toBeTruthy();
    expect(fadeUrl).toBeTruthy();
    expect(new URL(dayUrl!).searchParams.get("limit")).toBe("1000");
    expect(new URL(fadeUrl!).searchParams.get("limit")).toBe("1000");
    expect(new URL(dayUrl!).searchParams.get("window_start.gte")! > "2026-10-09").toBe(true);
    expect(new URL(fadeUrl!).searchParams.get("window_start.gte")! <= "2026-10-09").toBe(true);
    expect(urls.some((u) => u.includes("/v8/finance/chart/"))).toBe(false);
  });

  it("includes the Friday close on the Tuesday after Labor Day without widening the day query", async () => {
    setMassiveTestKey();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(zonedTimeToUtc(2026, 9, 8, 15, 30, 0));
    stubMarketFetch({ futuresAggs: fiveMinuteBars(4, 100) });
    await fetchDayMesFiveMinuteBars();
    await fetchCpiLateFadeMesFiveMinuteBars();
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    const dayUrl = urls.find((u) => u.includes("/futures/v1/aggs/") && u.includes("sort=window_start.asc"));
    const fadeUrl = urls.find((u) => u.includes("/futures/v1/aggs/") && u.includes("sort=window_start.desc"));
    expect(new URL(dayUrl!).searchParams.get("window_start.gte")! > "2026-09-04").toBe(true);
    expect(new URL(fadeUrl!).searchParams.get("window_start.gte")! <= "2026-09-04").toBe(true);
  });
});

describe("ATM call debit picker never sells puts", () => {
  it("picks long closer ATM and short further OTM calls only", () => {
    const { calls, puts } = massiveChainBodiesFromEtrade();
    const snap = parseMassiveOptionChain([calls, puts], "SPY", "2013-03-16");
    const pair = pickAtmCallDebit(snap.legs, 67);
    expect(pair).not.toBeNull();
    expect(pair!.long.right).toBe("C");
    expect(pair!.short.right).toBe("C");
    expect(pair!.short.strike).toBeGreaterThan(pair!.long.strike);
    expect(pair!.long.strike).toBe(65);
    expect(pair!.short.strike).toBe(70);
  });

  it("picks 30–45 DTE expiries above the 21 DTE exit", () => {
    const now = new Date("2026-08-01T15:00:00.000Z");
    const picked = pickTargetExpiry(
      [
        { year: 2026, month: 8, day: 14, expiry: "2026-08-14", expiryType: "WEEKLY" },
        { year: 2026, month: 9, day: 11, expiry: "2026-09-11", expiryType: "MONTHLY" },
        { year: 2026, month: 12, day: 18, expiry: "2026-12-18", expiryType: "MONTHLY" },
      ],
      now,
    );
    expect(picked?.expiry).toBe("2026-09-11");
  });
});
