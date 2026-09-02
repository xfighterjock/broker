import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedEvents } from "../shared/clock";
import type { CalendarEvent, StatusSnapshot } from "../shared/types";
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
import * as tradovate from "../server/src/tradovateBroker";
import {
  detectStopHits,
  lastCrossesStop,
  stopOnCorrectSide,
  validatePaperOrder,
} from "../server/src/paper";

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

function yahooBody(symbol: string, last: number, prev = last - 1) {
  return {
    chart: {
      result: [
        {
          meta: {
            symbol,
            regularMarketPrice: last,
            previousClose: prev,
            chartPreviousClose: prev,
            regularMarketTime: 1_787_847_253,
            exchangeName: "NYSE",
            instrumentType: "EQUITY",
          },
        },
      ],
      error: null,
    },
  };
}

const realFetch = globalThis.fetch;

function stubQuotes(lastBySymbol: Record<string, number> | number) {
  setMassiveTestKey();
  const map = typeof lastBySymbol === "number" ? lastBySymbol : lastBySymbol;
  stubMarketFetch({ lastBySymbol: map });
}

describe("paper stop side validation", () => {
  it("Buy requires stop below last; Sell requires stop above last", () => {
    expect(stopOnCorrectSide("Buy", 100, 99)).toBe(true);
    expect(stopOnCorrectSide("Buy", 100, 100)).toBe(false);
    expect(stopOnCorrectSide("Buy", 100, 101)).toBe(false);
    expect(stopOnCorrectSide("Sell", 100, 101)).toBe(true);
    expect(stopOnCorrectSide("Sell", 100, 100)).toBe(false);
    expect(stopOnCorrectSide("Sell", 100, 99)).toBe(false);
  });

  it("validatePaperOrder rejects the wrong stop side", () => {
    const buy = validatePaperOrder(
      { sleeveId: "momentum", symbol: "SPY", side: "Buy", qty: 1, stopPrice: 510, thesis: "x" },
      { last: 500, gateMode: "idle", dailyLossUsd: 500, dayPnl: 0, sleeveRealizedPnl: 0 },
    );
    expect(buy.ok).toBe(false);
    if (!buy.ok) expect(buy.error).toMatch(/below last/i);
    const sell = validatePaperOrder(
      { sleeveId: "momentum", symbol: "SPY", side: "Sell", qty: 1, stopPrice: 490, thesis: "x" },
      { last: 500, gateMode: "idle", dailyLossUsd: 500, dayPnl: 0, sleeveRealizedPnl: 0 },
    );
    expect(sell.ok).toBe(false);
    if (!sell.ok) expect(sell.error).toMatch(/above last/i);
  });
});

describe("day band refuses entry", () => {
  it("validatePaperOrder refuses market entry in NO-STOP BAND", () => {
    const r = validatePaperOrder(
      { sleeveId: "day", symbol: "MES", side: "Buy", qty: 1, stopPrice: 5700, thesis: "nfp" },
      {
        last: 5800,
        gateMode: "NO-STOP BAND",
        dailyLossUsd: 500,
        dayPnl: 0,
        sleeveRealizedPnl: 0,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/NO-STOP BAND/);
  });

  it("day sleeve $500 cap ignores broker-wide mock day P&L", () => {
    const r = validatePaperOrder(
      { sleeveId: "day", symbol: "MES", side: "Buy", qty: 1, stopPrice: 5790, thesis: "stoch" },
      {
        last: 5800,
        gateMode: "idle",
        dailyLossUsd: 500,
        dayPnl: -4140,
        sleeveRealizedPnl: 0,
      },
    );
    expect(r.ok).toBe(true);
  });

  it("day sleeve refuses when sleeve realized is already at the cap", () => {
    const r = validatePaperOrder(
      { sleeveId: "day", symbol: "MES", side: "Buy", qty: 1, stopPrice: 5790, thesis: "stoch" },
      {
        last: 5800,
        gateMode: "idle",
        dailyLossUsd: 500,
        dayPnl: 0,
        sleeveRealizedPnl: -500,
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/day P&L already at dailyLossUsd/);
  });

  it("HTTP refuses a day-sleeve entry while the clock is in band", async () => {
    const events: CalendarEvent[] = [
      {
        id: "band-now",
        timeUtc: new Date(Date.now() - 30_000).toISOString(),
        type: "CPI",
        flattenEt: "15:45",
      },
    ];
    const { app, broker } = makeTestApp(events);
    stubQuotes(5800);
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "day",
          symbol: "MES",
          side: "Buy",
          qty: 1,
          stopPrice: 5700,
          thesis: "should refuse",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/NO-STOP BAND/);
      expect(broker.getPositionsSync().filter((p) => p.side !== "Flat")).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });
});

describe("POST /api/paper/order fill-at-last", () => {
  let savedPassword: string | undefined;

  beforeEach(() => {
    savedPassword = process.env.GATE_PASSWORD;
    delete process.env.GATE_PASSWORD;
    resetQuoteCache();
    resetMassiveCache();
    resetRiskCache();
  });

  afterEach(() => {
    if (savedPassword === undefined) delete process.env.GATE_PASSWORD;
    else process.env.GATE_PASSWORD = savedPassword;
    clearMassiveTestKey();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetQuoteCache();
    resetMassiveCache();
    resetRiskCache();
  });

  it("fills the entry at the mocked delayed last and places a working stop", async () => {
    const { app, broker } = makeTestApp();
    const tv = vi.spyOn(tradovate, "createTradovateFromEnv");
    stubQuotes({ SPY: 500.25 });
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "momentum",
          symbol: "SPY",
          side: "Buy",
          qty: 1,
          stopPrice: 400,
          thesis: "breakout",
        }),
      });
      expect(res.status).toBe(200);
      const snap = (await res.json()) as StatusSnapshot;
      const pos = snap.broker.positions.find((p) => p.side !== "Flat");
      expect(pos).toMatchObject({
        symbol: "SPY",
        side: "Long",
        qty: 1,
        avgPrice: 500.25,
        sleeveId: "momentum",
      });
      const stop = snap.broker.orders.find(
        (o) => o.state === "Working" && o.type === "StopMarket",
      );
      expect(stop).toMatchObject({
        symbol: "SPY",
        side: "Sell",
        qty: 1,
        stopPrice: 400,
        sleeveId: "momentum",
      });
      expect(snap.paperBlotter.at(-1)).toMatchObject({
        sleeveId: "momentum",
        symbol: "SPY",
        side: "Buy",
        qty: 1,
        price: 500.25,
        notes: "breakout",
      });
      expect(tv).not.toHaveBeenCalled();
      const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
      const urls = fetchMock.mock.calls.map((c) => String(c[0]));
      const massive = urls.filter((u) => u.includes("/v2/snapshot/locale/us/markets/stocks/tickers/SPY"));
      expect(massive.length).toBeGreaterThan(0);
      for (const u of urls) {
        expect(u).not.toMatch(/tradovate/i);
      }
      expect(broker.getPositionsSync().some((p) => p.side === "Long")).toBe(true);
    } finally {
      await srv.close();
      broker.reset();
    }
  });

  it("returns 401 when GATE_PASSWORD is set and there is no session cookie", async () => {
    process.env.GATE_PASSWORD = "test-only-not-real";
    const { app } = makeTestApp();
    stubQuotes(100);
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "momentum",
          symbol: "SPY",
          side: "Buy",
          qty: 1,
          stopPrice: 90,
          thesis: "auth",
        }),
      });
      expect(res.status).toBe(401);
    } finally {
      await srv.close();
      delete process.env.GATE_PASSWORD;
    }
  });
});

describe("flatten on stop cross", () => {
  beforeEach(() => {
    delete process.env.GATE_PASSWORD;
    resetQuoteCache();
    resetMassiveCache();
    resetRiskCache();
  });
  afterEach(() => {
    clearMassiveTestKey();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    resetQuoteCache();
    resetMassiveCache();
    resetRiskCache();
  });

  it("detectStopHits fires when delayed last crosses the working stop", () => {
    expect(lastCrossesStop("Long", 400, 399)).toBe(true);
    expect(lastCrossesStop("Long", 400, 401)).toBe(false);
    expect(lastCrossesStop("Short", 600, 601)).toBe(true);
    expect(lastCrossesStop("Short", 600, 599)).toBe(false);
    const hits = detectStopHits(
      [
        {
          id: "pos-1",
          symbol: "SPY",
          root: null,
          qty: 1,
          side: "Long",
          avgPrice: 500,
          unrealizedPnl: 0,
          gated: false,
          sleeveId: "momentum",
        },
      ],
      [
        {
          id: "ord-1",
          symbol: "SPY",
          root: null,
          type: "StopMarket",
          side: "Sell",
          qty: 1,
          stopPrice: 400,
          state: "Working",
          gated: false,
          sleeveId: "momentum",
        },
      ],
      [
        {
          symbol: "SPY",
          last: 399,
          prevClose: 500,
          change: -101,
          changePct: null,
          asOf: null,
          exchange: "NYSE",
          delayed: true,
          source: "yahoo",
        },
      ],
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].last).toBe(399);
    expect(hits[0].realizedPnl).toBe(399 - 500);
  });

  it("GET /api/quotes flattens the mock position when last crosses the stop", async () => {
    const { app, broker } = makeTestApp();
    stubQuotes(500);
    const flatten = vi.spyOn(broker, "flattenSymbols");
    const cancel = vi.spyOn(broker, "cancelOrders");
    const tv = vi.spyOn(tradovate, "createTradovateFromEnv");
    const srv = await listen(app);
    try {
      const placed = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "momentum",
          symbol: "SPY",
          side: "Buy",
          qty: 1,
          stopPrice: 400,
          thesis: "stop-cross",
        }),
      });
      expect(placed.status).toBe(200);
      resetQuoteCache();
      stubQuotes(399);
      const q = await fetch(`${srv.url}/api/quotes?sleeve=momentum`);
      expect(q.status).toBe(200);
      expect(flatten).toHaveBeenCalled();
      expect(cancel).toHaveBeenCalled();
      expect(tv).not.toHaveBeenCalled();
      const snapRes = await fetch(`${srv.url}/api/status`);
      const snap = (await snapRes.json()) as StatusSnapshot;
      expect(snap.broker.positions.filter((p) => p.side !== "Flat")).toHaveLength(0);
      expect(snap.sleeves.momentum.paper.trades).toBe(1);
      expect(snap.sleeves.momentum.paper.losses).toBe(1);
      expect(snap.sleeves.momentum.paper.realizedPnlUsd).toBeCloseTo(399 - 500);
      const exit = snap.paperBlotter.find((f) => f.notes === "stop hit");
      expect(exit).toMatchObject({ symbol: "SPY", side: "Sell", price: 399 });
    } finally {
      await srv.close();
      broker.reset();
    }
  });
});

describe("paper path never calls tradovate", () => {
  it("paper.ts and the paper routes do not reference tradovate", () => {
    const paper = readFileSync(resolve("server/src/paper.ts"), "utf8");
    expect(paper).not.toMatch(/tradovate/i);
    expect(paper).not.toMatch(/EnterLong/);
    const app = readFileSync(resolve("server/src/app.ts"), "utf8");
    expect(app).not.toMatch(/createTradovateFromEnv/);
    expect(app).not.toMatch(/app\.(post|put|all)\([^)]*EnterLong/i);
    expect(app).not.toMatch(/\/api\/buy/);
    expect(app).toMatch(/\/api\/paper\/order/);
    expect(app).toMatch(/MockBroker only/);
  });
});
