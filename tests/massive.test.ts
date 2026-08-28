import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchDelayedQuotes,
  isYahooFuturesSymbol,
  mapTicker,
  resetQuoteCache,
} from "../server/src/quotes";
import {
  MASSIVE_KEY_MISSING,
  inferExpiryType,
  parseMassiveDailyBars,
  parseMassiveOptionChain,
  parseMassiveSnapshotQuote,
  parseOptionsUnderlying,
  resetMassiveCache,
} from "../server/src/massive";
import { pickAtmCallDebit, pickTargetExpiry } from "../server/src/autopilot";
import {
  MASSIVE_TEST_KEY,
  clearMassiveTestKey,
  massiveAggsBody,
  massiveChainBodiesFromEtrade,
  massiveSnapshotBody,
  setMassiveTestKey,
  stubMarketFetch,
} from "./helpers/massiveStub";

afterEach(() => {
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
  it("routes MES=F to Yahoo and AAPL to Massive", () => {
    expect(isYahooFuturesSymbol("MES=F")).toBe(true);
    expect(isYahooFuturesSymbol(mapTicker("MES")!)).toBe(true);
    expect(isYahooFuturesSymbol("AAPL")).toBe(false);
    expect(isYahooFuturesSymbol("SPY")).toBe(false);
  });
});

describe("fetchDelayedQuotes Massive vs Yahoo", () => {
  beforeEach(() => {
    resetQuoteCache();
    resetMassiveCache();
  });

  it("uses Yahoo for futures and Massive for equities when the key is set", async () => {
    setMassiveTestKey();
    stubMarketFetch({ lastBySymbol: { "MES=F": 5800, SPY: 500 } });
    const quotes = await fetchDelayedQuotes(["MES", "SPY"]);
    const mes = quotes.find((q) => q.symbol === "MES=F");
    const spy = quotes.find((q) => q.symbol === "SPY");
    expect(mes?.source).toBe("yahoo");
    expect(mes?.last).toBe(5800);
    expect(spy?.source).toBe("massive");
    expect(spy?.last).toBe(500);
    expect(spy?.delayed).toBe(true);
    const urls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/v8/finance/chart/") && u.includes("MES"))).toBe(true);
    expect(urls.some((u) => u.includes("/v2/snapshot/locale/us/markets/stocks/tickers/SPY"))).toBe(true);
    expect(urls.every((u) => !/apiKey=/i.test(u))).toBe(true);
    expect(MASSIVE_TEST_KEY).toBeTruthy();
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
