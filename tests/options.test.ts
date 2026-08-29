import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedEvents } from "../shared/clock";
import type { CalendarEvent, OptionChainSnapshot, OptionLeg, StatusSnapshot } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { resetQuoteCache } from "../server/src/quotes";
import { resetMassiveCache } from "../server/src/massive";
import { resetRiskCache } from "../server/src/risk";
import {
  clearMassiveTestKey,
  setMassiveTestKey,
  stubMarketFetch,
} from "./helpers/massiveStub";
import { StatusHub } from "../server/src/wsHub";
import {
  applySandboxVerticalFallback,
  parseOptionChain,
  parseOptionExpireDates,
  parseOptionLeg,
  resetEtradeCache,
  uniqueStrikes,
} from "../server/src/etrade";
import {
  detectVerticalExits,
  makeVerticalMeta,
  setPaperNow,
  sizeDebitContracts,
  validateDebitVertical,
} from "../server/src/vertical";

const chainFixture = JSON.parse(
  readFileSync(resolve("tests/fixtures/etrade-optionchain.json"), "utf8"),
) as unknown;
const expiryFixture = JSON.parse(
  readFileSync(resolve("tests/fixtures/etrade-expiries.json"), "utf8"),
) as unknown;

function testCfg(): AppConfig {
  return {
    databaseUrl: "postgres://x",
    redisUrl: "redis://127.0.0.1:6379",
    port: 0,
    bind: "127.0.0.1",
    gatePassword: undefined,
    tradingMode: "mock",
    nodeEnv: "test",
    cookieSecure: false,
    authMode: "cookie",
    tradovateBaseUrl: undefined,
  };
}

function makeTestApp(events: CalendarEvent[] = seedEvents()) {
  const broker = new MockBroker();
  const engine = new GateEngine(broker, () => new Date(), () => events, {
    enabled: false,
    dailyLossUsd: 500,
  });
  const hub = new StatusHub();
  const app = buildApp({
    cfg: testCfg(),
    pool: null,
    redis: null,
    redisPub: null,
    broker,
    engine,
    getEvents: () => events,
    setEvents: () => {},
    hub,
    brokerName: "MockBroker",
    brokerMode: "mock",
    liveRefused: false,
    stubNote: null,
  });
  return { app, broker, engine };
}

async function listen(app: ReturnType<typeof buildApp>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no listen address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function dummyEtradeEnv() {
  process.env.ETRADE_ENV = "sandbox";
  process.env.ETRADE_SANDBOX_KEY = "test-consumer-key";
  process.env.ETRADE_SANDBOX_SECRET = "test-consumer-secret";
  process.env.ETRADE_SANDBOX_ACCESS_TOKEN = "test-access-token";
  process.env.ETRADE_SANDBOX_ACCESS_SECRET = "test-access-secret";
}

function clearEtradeEnv() {
  delete process.env.ETRADE_ENV;
  delete process.env.ETRADE_SANDBOX_KEY;
  delete process.env.ETRADE_SANDBOX_SECRET;
  delete process.env.ETRADE_SANDBOX_ACCESS_TOKEN;
  delete process.env.ETRADE_SANDBOX_ACCESS_SECRET;
  delete process.env.ETRADE_PROD_KEY;
  delete process.env.ETRADE_PROD_SECRET;
  delete process.env.ETRADE_PROD_ACCESS_TOKEN;
  delete process.env.ETRADE_PROD_ACCESS_SECRET;
  delete process.env.ETRADE_KEY;
  delete process.env.ETRADE_SECRET;
  delete process.env.ETRADE_ACCESS_TOKEN;
  delete process.env.ETRADE_ACCESS_SECRET;
}

const realFetch = globalThis.fetch;

function stubMarket(_opts?: { chain?: unknown; expiries?: unknown }) {
  stubMarketFetch({ lastBySymbol: { SPY: 500, AAPL: 67 } });
}

function legAt(chain: OptionChainSnapshot, strike: number, right: "C" | "P"): OptionLeg {
  const hit = chain.legs.find((l) => l.right === right && Math.abs(l.strike - strike) < 1e-9);
  if (!hit) throw new Error(`missing ${right} ${strike}`);
  return { ...hit };
}

describe("parse E*TRADE option chain + greeks", () => {
  it("surfaces the actual underlyer/expiry/strikes and greeks from OptionPair payload", () => {
    const snap = parseOptionChain(chainFixture, "SPY");
    expect(snap.symbol).toBe("SPY");
    expect(snap.underlying).toBe("AAPL");
    expect(snap.expiry).toBe("2013-03-16");
    expect(snap.delayed).toBe(true);
    expect(snap.source).toBe("etrade-sandbox");
    expect(snap.legs.length).toBe(6);
    const call65 = snap.legs.find((l) => l.right === "C" && l.strike === 65);
    expect(call65).toMatchObject({
      underlying: "AAPL",
      osiKey: "AAPL--130316C00065000",
      displaySymbol: "AAPL Mar 16 '13 $65 Call",
      right: "C",
      strike: 65,
      expiry: "2013-03-16",
      bid: 5.1,
      ask: 5.2,
      last: 5.15,
      bidSize: 11,
      askSize: 14,
      openInterest: 1840,
      delta: 0.61,
      gamma: 0.028,
      theta: -0.045,
      vega: 0.11,
      iv: 0.21,
    });
    const put70 = snap.legs.find((l) => l.right === "P" && l.strike === 70);
    expect(put70?.delta).toBe(-0.58);
    expect(put70?.osiKey).toBe("AAPL--130316P00070000");
  });

  it("parses a single OptionPair object and expiry list", () => {
    const pair = (chainFixture as { OptionChainResponse: { OptionPair: unknown[] } })
      .OptionChainResponse.OptionPair[0];
    const snap = parseOptionChain(
      { OptionChainResponse: { OptionPair: pair, SelectedED: { day: 16, month: 3, year: 2013 } } },
      "QQQ",
    );
    expect(snap.legs).toHaveLength(2);
    const dates = parseOptionExpireDates(expiryFixture, "IWM");
    expect(dates.expiries.map((e) => e.expiry)).toEqual([
      "2013-03-16",
      "2013-03-22",
      "2013-04-19",
    ]);
    expect(dates.expiries[1].expiryType).toBe("WEEKLY");
  });

  it("parseOptionLeg returns null without a strike", () => {
    expect(parseOptionLeg({ bid: 1, ask: 2, optionType: "CALL" }, "C", "2013-03-16")).toBeNull();
  });
});

describe("size debit vertical 1–2% cap", () => {
  const chain = parseOptionChain(chainFixture, "SPY");

  it("auto-sizes near 1% and stays under 2% of $100k", () => {
    const long = { ...legAt(chain, 65, "C"), ask: 5 };
    const short = { ...legAt(chain, 70, "C"), bid: 2.5 };
    const v = validateDebitVertical({ long, short, quoteSymbol: "SPY" }, 100_000);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // debit 5-2.5=2.5 exactly → $250/ct. 1% of 100k = 1000 → 4 contracts ($1000). 2% cap $2000.
    expect(v.netDebitPerShare).toBeCloseTo(2.5);
    expect(v.qty).toBe(4);
    expect(v.netDebitPaid).toBeCloseTo(1000);
    expect(v.maxLoss).toBeCloseTo(1000);
    expect(v.width).toBe(5);
    expect(v.maxProfit).toBeCloseTo(1000);
    expect(v.qty * v.netDebitPerShare * 100).toBeLessThanOrEqual(2000);
  });

  it("refuses when 1 contract exceeds the 2% cap", () => {
    const sized = sizeDebitContracts(2.8, 10_000);
    expect(sized.ok).toBe(false);
    if (!sized.ok) expect(sized.error).toMatch(/2%/);
  });

  it("honors an explicit qty that fits the cap", () => {
    const sized = sizeDebitContracts(2.8, 100_000, 2);
    expect(sized.ok).toBe(true);
    if (sized.ok) expect(sized.qty).toBe(2);
    const tooBig = sizeDebitContracts(2.8, 100_000, 20);
    expect(tooBig.ok).toBe(false);
  });
});

describe("refuse credit / naked / mixed-expiry / mixed-right", () => {
  const chain = parseOptionChain(chainFixture, "SPY");

  it("refuses a credit (short closer to ATM / net debit <= 0)", () => {
    const long = legAt(chain, 70, "C");
    const short = legAt(chain, 65, "C");
    const v = validateDebitVertical({ long, short, qty: 1, quoteSymbol: "SPY" }, 100_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/credit|OTM|debit/i);
  });

  it("refuses mixed expiry", () => {
    const long = legAt(chain, 65, "C");
    const short = { ...legAt(chain, 70, "C"), expiry: "2013-04-19" };
    const v = validateDebitVertical({ long, short, qty: 1, quoteSymbol: "SPY" }, 100_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/mixed-expiry/);
  });

  it("refuses mixed right", () => {
    const long = legAt(chain, 65, "C");
    const short = legAt(chain, 70, "P");
    const v = validateDebitVertical({ long, short, qty: 1, quoteSymbol: "SPY" }, 100_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/mixed-right/);
  });

  it("refuses missing bid/ask", () => {
    const long = { ...legAt(chain, 65, "C"), ask: null };
    const short = legAt(chain, 70, "C");
    const v = validateDebitVertical({ long, short, qty: 1, quoteSymbol: "SPY" }, 100_000);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/bid\/ask/);
  });

  it("put debit requires long higher strike", () => {
    const long = legAt(chain, 70, "P");
    const short = legAt(chain, 65, "P");
    const v = validateDebitVertical({ long, short, qty: 1, quoteSymbol: "SPY" }, 100_000);
    expect(v.ok).toBe(true);
    const inverted = validateDebitVertical(
      { long: short, short: long, qty: 1, quoteSymbol: "SPY" },
      100_000,
    );
    expect(inverted.ok).toBe(false);
  });
});

describe("vertical exits with injected clock", () => {
  const chain = parseOptionChain(chainFixture, "SPY");
  const asOfOpen = "2013-02-01T15:00:00.000Z"; // DTE 43 vs 2013-03-16

  function openPos(marks?: { longBid?: number; shortAsk?: number }) {
    const long = { ...legAt(chain, 65, "C"), bid: marks?.longBid ?? 5.1, ask: 4.9 };
    const short = { ...legAt(chain, 70, "C"), ask: marks?.shortAsk ?? 2.5 };
    const v = validateDebitVertical({ long, short, qty: 1, asOf: asOfOpen, quoteSymbol: "SPY" }, 100_000);
    if (!v.ok) throw new Error(v.error);
    const meta = makeVerticalMeta(v, asOfOpen);
    if (marks?.longBid !== undefined) meta.long = { ...meta.long, bid: marks.longBid };
    if (marks?.shortAsk !== undefined) meta.short = { ...meta.short, ask: marks.shortAsk };
    return {
      id: "pos-v",
      symbol: "AAPL 65/70 C 2013-03-16",
      root: null,
      qty: 1,
      side: "Long" as const,
      avgPrice: v.netDebitPerShare,
      unrealizedPnl: 0,
      gated: false,
      sleeveId: "options" as const,
      vertical: meta,
    };
  }

  afterEach(() => setPaperNow(null));

  it("exits at 50% of max profit", () => {
    // debit 2.5, maxProfit 2.5*100=250. 50% profit = 125. Need close-250 >= 125 → close >= 375 → longBid-shortAsk >= 3.75
    const p = openPos({ longBid: 5.5, shortAsk: 1.4 });
    const hits = detectVerticalExits([p], new Date(asOfOpen));
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/50% max profit/);
    expect(hits[0].realizedPnl).toBeGreaterThan(0);
  });

  it("exits when 50% of debit is gone", () => {
    // debit paid 250. 50% stop when close value <= 125 → longBid-shortAsk <= 1.25
    const p = openPos({ longBid: 1.2, shortAsk: 1.5 });
    const hits = detectVerticalExits([p], new Date(asOfOpen));
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/50% debit stop/);
  });

  it("exits at DTE <= 21 with injected clock, not wall clock", () => {
    const p = openPos();
    const stillOpen = detectVerticalExits([p], new Date(asOfOpen));
    expect(stillOpen).toHaveLength(0);
    const nearExpiry = detectVerticalExits([p], new Date("2013-02-24T15:00:00.000Z"));
    expect(nearExpiry).toHaveLength(1);
    expect(nearExpiry[0].reason).toMatch(/DTE/);
    const wall = detectVerticalExits([p], new Date("2026-08-27T18:00:00.000Z"));
    expect(wall).toHaveLength(1);
    expect(wall[0].reason).toMatch(/DTE/);
  });
});

describe("HTTP options chain + paper vertical (mocked E*TRADE)", () => {
  let savedPassword: string | undefined;

  beforeEach(() => {
    savedPassword = process.env.GATE_PASSWORD;
    delete process.env.GATE_PASSWORD;
    dummyEtradeEnv();
    setMassiveTestKey();
    resetQuoteCache();
    resetEtradeCache();
    resetMassiveCache();
    resetRiskCache();
    setPaperNow(new Date("2013-02-01T15:00:00.000Z")); // Fri 10:00 ET — window open, sandbox DTE intact
  });

  afterEach(() => {
    if (savedPassword === undefined) delete process.env.GATE_PASSWORD;
    else process.env.GATE_PASSWORD = savedPassword;
    clearEtradeEnv();
    clearMassiveTestKey();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetQuoteCache();
    resetEtradeCache();
    resetMassiveCache();
    resetRiskCache();
    setPaperNow(null);
  });

  it("GET /api/options/chain returns normalized legs from fixture JSON", async () => {
    const { app } = makeTestApp();
    stubMarket();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/options/chain?symbol=SPY&expiry=2013-03-16`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as OptionChainSnapshot;
      expect(body.underlying).toBe("AAPL");
      expect(body.expiry).toBe("2013-03-16");
      expect(body.legs.some((l) => l.strike === 65 && l.right === "C" && l.delta === 0.61)).toBe(true);
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      for (const c of fetchMock.mock.calls) {
        expect(String(c[0])).not.toMatch(/\/v1\/order/i);
        expect(String(c[0])).not.toMatch(/tradovate/i);
      }
    } finally {
      await srv.close();
    }
  });

  it("GET /api/options/expiries returns 503 when E*TRADE creds are missing (no secrets)", async () => {
    clearEtradeEnv();
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/options/expiries?symbol=SPY`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/E\*TRADE/);
      expect(JSON.stringify(body)).not.toMatch(/test-consumer/);
      expect(JSON.stringify(body)).not.toMatch(/test-access/);
      expect(JSON.stringify(body)).not.toMatch(/ETRADE_PROD_/);
    } finally {
      await srv.close();
    }
  });

  it("GET /api/options/expiries rejects MES=F and accepts AAPL", async () => {
    const { app } = makeTestApp();
    stubMarket();
    const srv = await listen(app);
    try {
      const bad = await fetch(`${srv.url}/api/options/expiries?symbol=MES=F`);
      expect(bad.status).toBe(400);
      const ok = await fetch(`${srv.url}/api/options/expiries?symbol=AAPL`);
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { symbol: string; expiries: { expiry: string }[] };
      expect(body.symbol).toBe("AAPL");
      expect(body.expiries.some((e) => e.expiry === "2013-03-16")).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("POST /api/paper/vertical opens a two-leg debit on MockBroker and journals both legs", async () => {
    const { app, broker } = makeTestApp();
    stubMarket();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/vertical`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "options",
          symbol: "SPY",
          right: "C",
          expiry: "2013-03-16",
          longStrike: 65,
          shortStrike: 75,
          qty: 1,
          thesis: "fixture debit",
          asOf: "2013-02-01T15:00:00.000Z",
        }),
      });
      expect(res.status).toBe(200);
      const snap = (await res.json()) as StatusSnapshot;
      const pos = snap.broker.positions.find((p) => p.side !== "Flat");
      expect(pos?.sleeveId).toBe("options");
      expect(pos?.vertical?.kind).toBe("debit-vertical");
      expect(pos?.vertical?.qty).toBe(1);
      expect(pos?.vertical?.netDebitPaid).toBeCloseTo(410);
      expect(pos?.vertical?.maxLoss).toBeCloseTo(410);
      expect(pos?.vertical?.maxProfit).toBeCloseTo(590);
      expect(pos?.vertical?.long.osiKey).toContain("C00065000");
      expect(pos?.vertical?.short.osiKey).toContain("C00075000");
      const buys = snap.paperBlotter.filter((f) => f.notes.includes("vertical long"));
      const sells = snap.paperBlotter.filter((f) => f.notes.includes("vertical short"));
      expect(buys).toHaveLength(1);
      expect(sells).toHaveLength(1);
      expect(buys[0].price).toBe(5.2);
      expect(sells[0].price).toBe(1.1);
      expect(broker.getPositionsSync().some((p) => p.vertical)).toBe(true);
    } finally {
      await srv.close();
      broker.reset();
    }
  });

  it("POST /api/paper/order on options sleeve without a vertical is refused (no stock legs)", async () => {
    const { app, broker } = makeTestApp();
    stubMarket();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "options",
          symbol: "SPY",
          side: "Buy",
          qty: 1,
          stopPrice: 400,
          thesis: "stock",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/debit verticals only|no stock/i);
      expect(broker.getPositionsSync().filter((p) => p.side !== "Flat")).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it("refuses a credit vertical over HTTP", async () => {
    const { app } = makeTestApp();
    stubMarket();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/vertical`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "options",
          symbol: "SPY",
          right: "C",
          expiry: "2013-03-16",
          longStrike: 70,
          shortStrike: 65,
          qty: 1,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/credit|OTM|debit/i);
    } finally {
      await srv.close();
    }
  });
});

describe("options source never places broker orders", () => {
  it("etrade.ts is chain-only (no order paths, no PIN handshake)", () => {
    const src = readFileSync(resolve("server/src/etrade.ts"), "utf8");
    expect(src).not.toMatch(/\/v1\/order/);
    expect(src).not.toMatch(/placeOrder/i);
    expect(src).not.toMatch(/request_token/i);
    expect(src).toMatch(/optionchains/);
    expect(src).toMatch(/optionexpiredate/);
    const app = readFileSync(resolve("server/src/app.ts"), "utf8");
    expect(app).toMatch(/\/api\/paper\/vertical/);
    expect(app).toMatch(/\/api\/paper\/csp/);
    expect(app).toMatch(/\/api\/options\/chain/);
    expect(app).not.toMatch(/createTradovateFromEnv/);
  });

  it("app.ts uses etrade chain fetch, not Massive", () => {
    const app = readFileSync(resolve("server/src/app.ts"), "utf8");
    const etradeBlock = [...app.matchAll(/import \{([^}]+)\} from ["']\.\/etrade["']/g)]
      .map((m) => m[1])
      .join("\n");
    expect(etradeBlock).toMatch(/fetchOptionChain/);
    expect(etradeBlock).toMatch(/fetchOptionExpiries/);
    const massiveBlock = [...app.matchAll(/import \{([^}]+)\} from ["']\.\/massive["']/g)]
      .map((m) => m[1])
      .join("\n");
    expect(massiveBlock).not.toMatch(/fetchOptionChain/);
    expect(massiveBlock).not.toMatch(/fetchOptionExpiries/);
  });

  it("OAuth PIN flow lives in scripts/etrade-oauth.mjs, not etrade.ts", () => {
    const script = readFileSync(resolve("scripts/etrade-oauth.mjs"), "utf8");
    expect(script).toMatch(/request_token/);
    expect(script).toMatch(/us\.etrade\.com\/e\/t\/etws\/authorize/);
    expect(script).toMatch(/chmodSync\([^,]+, 0o600\)/);
    expect(script).not.toMatch(/\/v1\/order/);
    expect(script).not.toMatch(/placeOrder/i);
    const src = readFileSync(resolve("server/src/etrade.ts"), "utf8");
    expect(src).not.toMatch(/request_token/i);
  });
});


describe("sandbox vertical fallback", () => {
  it("sandbox one-strike chain widens to fixture so a debit vertical can paper", () => {
  const thin = parseOptionChain(
    {
      OptionChainResponse: {
        OptionPair: [
          {
            Call: {
              optionRootSymbol: "AAPL",
              osiKey: "AAPL--130322C00485000",
              displaySymbol: "AAPL Mar 22 13 485 Call",
              optionType: "CALL",
              strikePrice: 485,
              bid: 0.02,
              ask: 0.01,
            },
            Put: {
              optionRootSymbol: "AAPL",
              osiKey: "AAPL--130322P00485000",
              displaySymbol: "AAPL Mar 22 13 485 Put",
              optionType: "PUT",
              strikePrice: 485,
              bid: 23.6,
              ask: 23.9,
            },
          },
        ],
      },
    },
    "SPY",
  );
  expect(uniqueStrikes(thin.legs)).toBe(1);
  const wide = applySandboxVerticalFallback(thin);
  expect(uniqueStrikes(wide.legs)).toBeGreaterThanOrEqual(2);
  expect(wide.underlying).toBe("AAPL");
  expect(wide.source).toBe("etrade-sandbox");
});
});
