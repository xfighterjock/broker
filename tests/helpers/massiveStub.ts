import { expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseOptionChain } from "../../server/src/etrade";
import type { OptionChainSnapshot, OptionLeg } from "../../shared/types";

const chainFixture = JSON.parse(
  readFileSync(resolve("tests/fixtures/etrade-optionchain.json"), "utf8"),
) as unknown;

export const MASSIVE_TEST_KEY = "test-massive-key-not-real";

export function massiveSnapshotBody(symbol: string, last: number, prev = last - 1) {
  return {
    status: "OK",
    ticker: {
      ticker: symbol,
      todaysChange: last - prev,
      todaysChangePerc: prev !== 0 ? ((last - prev) / prev) * 100 : 0,
      updated: 1_605_195_918_306_274_000,
      lastTrade: { p: last, t: 1_605_195_918_306_274_000, s: 100 },
      prevDay: { c: prev, v: 1_000_000 },
      day: { c: last, v: 500_000 },
    },
  };
}

export function massiveAggsBody(closes: number[], vol = 1_000_000) {
  return {
    ticker: "X",
    adjusted: true,
    resultsCount: closes.length,
    results: closes.map((c, i) => ({
      c,
      v: vol,
      o: c,
      h: c,
      l: c,
      t: 1_600_000_000_000 + i * 86_400_000,
    })),
    status: "OK",
  };
}

export function barsCloses(n: number, last = 100, step = 0.01): number[] {
  return Array.from({ length: n }, (_, i) => last - (n - 1 - i) * step);
}

function etradeToMassiveResults(snap: OptionChainSnapshot, contractType?: "call" | "put") {
  const want = contractType === "call" ? "C" : contractType === "put" ? "P" : null;
  return snap.legs
    .filter((l) => (want ? l.right === want : true))
    .map((l: OptionLeg) => ({
      details: {
        contract_type: l.right === "C" ? "call" : "put",
        expiration_date: l.expiry,
        strike_price: l.strike,
        ticker: l.osiKey.startsWith("O:") ? l.osiKey : `O:${l.osiKey.replace(/-/g, "")}`,
        shares_per_contract: 100,
      },
      last_quote: {
        bid: l.bid,
        ask: l.ask,
        bid_size: l.bidSize,
        ask_size: l.askSize,
        timeframe: "DELAYED",
      },
      last_trade: { price: l.last, timeframe: "DELAYED" },
      open_interest: l.openInterest,
      greeks: { delta: l.delta, gamma: l.gamma, theta: l.theta, vega: l.vega },
      implied_volatility: l.iv,
      underlying_asset: { ticker: l.underlying, timeframe: "DELAYED", price: 67 },
    }));
}

export function massiveChainBodiesFromEtrade(): { calls: unknown; puts: unknown; expiries: unknown } {
  const snap = parseOptionChain(chainFixture, "SPY");
  const expiries = {
    status: "OK",
    results: [
      { expiration_date: "2013-03-16", contract_type: "call", underlying_ticker: "AAPL" },
      { expiration_date: "2013-03-22", contract_type: "call", underlying_ticker: "AAPL" },
      { expiration_date: "2013-04-19", contract_type: "call", underlying_ticker: "AAPL" },
    ],
  };
  return {
    calls: { status: "OK", results: etradeToMassiveResults(snap, "call") },
    puts: { status: "OK", results: etradeToMassiveResults(snap, "put") },
    expiries,
  };
}

const realFetch = globalThis.fetch;

export type StubMarketOpts = {
  lastBySymbol?: Record<string, number> | number;
  aggs?: Record<string, number[]>;
  chain?: { calls: unknown; puts: unknown; expiries: unknown };
};

/** Mock Massive + Yahoo futures. Never hits the network except localhost. */
export function stubMarketFetch(opts: StubMarketOpts = {}) {
  const lastBy = opts.lastBySymbol ?? 100;
  const chain = opts.chain ?? massiveChainBodiesFromEtrade();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).not.toMatch(/tradovate/i);
      expect(url).not.toMatch(/\/v1\/order/i);
      expect(url).not.toMatch(/apiKey=/i);
      if (url.includes("127.0.0.1") || url.includes("localhost")) {
        return realFetch(input as RequestInfo, init);
      }
      if (url.includes("/v8/finance/chart/")) {
        const after = url.slice(url.indexOf("/chart/") + "/chart/".length);
        const symbol = decodeURIComponent(after.split("?")[0]);
        const last =
          typeof lastBy === "number"
            ? lastBy
            : lastBy[symbol] ?? lastBy[symbol.replace("=F", "")] ?? 100;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            chart: {
              result: [
                {
                  meta: {
                    symbol,
                    regularMarketPrice: last,
                    previousClose: last - 1,
                    regularMarketTime: 1_787_847_253,
                    exchangeName: "CME",
                  },
                },
              ],
              error: null,
            },
          }),
          text: async () => "{}",
        };
      }
      if (url.includes("/v2/snapshot/locale/us/markets/stocks/tickers/")) {
        const symbol = decodeURIComponent(url.split("/tickers/")[1]?.split("?")[0] ?? "X").toUpperCase();
        const last =
          typeof lastBy === "number" ? lastBy : lastBy[symbol] ?? 100;
        const body = massiveSnapshotBody(symbol, last);
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      if (url.includes("/v2/aggs/ticker/")) {
        const ticker = decodeURIComponent(url.split("/ticker/")[1]?.split("/")[0] ?? "X").toUpperCase();
        const closes = opts.aggs?.[ticker] ?? barsCloses(220, 100);
        const body = massiveAggsBody(closes);
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      if (url.includes("/v3/reference/options/contracts")) {
        return {
          ok: true,
          status: 200,
          json: async () => chain.expiries,
          text: async () => JSON.stringify(chain.expiries),
        };
      }
      if (url.includes("/v3/snapshot/options/")) {
        const isPut = /contract_type=put/i.test(url);
        const body = isPut ? chain.puts : chain.calls;
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () => JSON.stringify(body),
        };
      }
      return realFetch(input as RequestInfo, init);
    }),
  );
}

export function setMassiveTestKey() {
  process.env.MASSIVE_API_KEY = MASSIVE_TEST_KEY;
}

export function clearMassiveTestKey() {
  delete process.env.MASSIVE_API_KEY;
}
