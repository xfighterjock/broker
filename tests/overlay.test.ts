import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedEvents } from "../shared/clock";
import type { CalendarEvent, OptionChainSnapshot, StatusSnapshot } from "../shared/types";
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
import { parseOptionChain, resetEtradeCache } from "../server/src/etrade";
import {
  detectOverlaySettlements,
  matchingOwnershipLong,
  optionsFreeCash,
  overlayCashReserved,
  validateCoveredCall,
  validateCsp,
} from "../server/src/overlay";
import { setPaperNow } from "../server/src/vertical";

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
  delete process.env.ETRADE_SANDBOX_KEY;
  delete process.env.ETRADE_SANDBOX_SECRET;
  delete process.env.ETRADE_SANDBOX_ACCESS_TOKEN;
  delete process.env.ETRADE_SANDBOX_ACCESS_SECRET;
}

const realFetch = globalThis.fetch;

function stubMarket(lastBySymbol: Record<string, number> = { SPY: 500, AAPL: 60, QQQ: 400, IWM: 200 }) {
  stubMarketFetch({ lastBySymbol });
}

const chain = parseOptionChain(chainFixture, "SPY");
function put(strike: number) {
  const hit = chain.legs.find((l) => l.right === "P" && l.strike === strike);
  if (!hit) throw new Error("missing put");
  return { ...hit };
}
function call(strike: number) {
  const hit = chain.legs.find((l) => l.right === "C" && l.strike === strike);
  if (!hit) throw new Error("missing call");
  return { ...hit };
}

describe("CSP / covered-call validation", () => {
  it("refuses CSP when reserved cash exceeds options cash", () => {
    const v = validateCsp(
      {
        leg: put(65),
        qty: 16,
        quoteSymbol: "SPY",
        thesisSleeve: "ownership",
        thesisSymbol: "SPY",
        taLevel: "200dma",
      },
      100_000,
    );
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/exceeds options cash|never naked/i);
  });

  it("sizes a cash-secured put when cash is enough", () => {
    const v = validateCsp(
      {
        leg: put(65),
        qty: 1,
        quoteSymbol: "SPY",
        thesisSleeve: "ownership",
        thesisSymbol: "SPY",
        taLevel: "TA",
      },
      100_000,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.cashReserved).toBe(6500);
    expect(v.premiumPerShare).toBe(1.4);
    expect(v.premiumReceived).toBeCloseTo(140);
  });

  it("refuses a naked covered call", () => {
    const v = validateCoveredCall({
      leg: call(70),
      qty: 1,
      quoteSymbol: "SPY",
      thesisSleeve: "ownership",
      thesisSymbol: "SPY",
      taLevel: "",
      stock: null,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/naked call/i);
  });

  it("refuses a call strike that would not profit vs cost", () => {
    const v = validateCoveredCall({
      leg: call(65),
      qty: 1,
      quoteSymbol: "SPY",
      thesisSleeve: "ownership",
      thesisSymbol: "SPY",
      taLevel: "",
      stock: {
        id: "own",
        symbol: "SPY",
        root: null,
        qty: 100,
        side: "Long",
        avgPrice: 80,
        unrealizedPnl: 0,
        gated: false,
        sleeveId: "ownership",
      },
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/below cost/i);
  });

  it("assignment transfers stock to ownership at strike - premium", () => {
    const pos = {
      id: "csp",
      symbol: "AAPL 65 P 2013-03-16 CSP",
      root: null,
      qty: 1,
      side: "Short" as const,
      avgPrice: 1.4,
      unrealizedPnl: 0,
      gated: false,
      sleeveId: "options" as const,
      overlay: {
        kind: "csp" as const,
        right: "P" as const,
        expiry: "2013-03-16",
        underlying: "AAPL",
        quoteSymbol: "SPY",
        qty: 1,
        strike: 65,
        premiumPerShare: 1.4,
        premiumReceived: 140,
        cashReserved: 6500,
        thesisSleeve: "ownership" as const,
        thesisSymbol: "SPY",
        taLevel: "200dma",
        openedAt: "2013-03-16T15:00:00.000Z",
        asOf: "2013-03-16T15:00:00.000Z",
        leg: put(65),
      },
    };
    const hits = detectOverlaySettlements([pos], { AAPL: 60, SPY: 60 });
    expect(hits).toHaveLength(1);
    expect(hits[0].reason).toMatch(/assigned/i);
    expect(hits[0].stockTransfer).toMatchObject({
      action: "assign",
      sleeveId: "ownership",
      qty: 100,
      price: 63.6,
      symbol: "SPY",
    });
  });
});

describe("HTTP overlay (mocked Massive, MockBroker only)", () => {
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
    setPaperNow(null);
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

  it("POST /api/paper/csp refuses when cash is insufficient", async () => {
    const { app } = makeTestApp();
    stubMarket();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/csp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "options",
          symbol: "SPY",
          expiry: "2013-03-16",
          strike: 65,
          qty: 16,
          thesisSleeve: "ownership",
          asOf: "2013-02-01T15:00:00.000Z",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/cash|naked/i);
    } finally {
      await srv.close();
    }
  });

  it("POST /api/paper/covered-call refuses a naked call", async () => {
    const { app } = makeTestApp();
    stubMarket();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/covered-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "options",
          symbol: "SPY",
          expiry: "2013-03-16",
          strike: 70,
          qty: 1,
          thesisSleeve: "ownership",
          asOf: "2013-02-01T15:00:00.000Z",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/naked call/i);
    } finally {
      await srv.close();
    }
  });

  it("POST /api/paper/covered-call refuses strike below cost", async () => {
    const { app, broker } = makeTestApp();
    stubMarket();
    broker.injectPosition({
      symbol: "SPY",
      qty: 100,
      side: "Long",
      avgPrice: 80,
      sleeveId: "ownership",
    });
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/covered-call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "options",
          symbol: "SPY",
          expiry: "2013-03-16",
          strike: 65,
          qty: 1,
          thesisSleeve: "ownership",
          thesisSymbol: "SPY",
          asOf: "2013-02-01T15:00:00.000Z",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/below cost/i);
    } finally {
      await srv.close();
      broker.reset();
    }
  });

  it("CSP assignment on snapshot transfers stock to ownership", async () => {
    const { app, broker } = makeTestApp();
    stubMarket({ SPY: 60, AAPL: 60 });
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/csp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "options",
          symbol: "SPY",
          expiry: "2013-03-16",
          strike: 65,
          qty: 1,
          thesisSleeve: "ownership",
          thesisSymbol: "SPY",
          taLevel: "200dma",
          asOf: "2013-03-16T15:00:00.000Z",
        }),
      });
      expect(res.status).toBe(200);
      const snap = (await res.json()) as StatusSnapshot;
      const cspOpen = snap.broker.positions.filter(
        (p) => p.side !== "Flat" && p.overlay?.kind === "csp",
      );
      expect(cspOpen).toHaveLength(0);
      const stock = matchingOwnershipLong(snap.broker.positions, ["SPY"]);
      expect(stock?.sleeveId).toBe("ownership");
      expect(stock?.qty).toBe(100);
      expect(stock?.avgPrice).toBeCloseTo(63.6);
      expect(snap.sleeveBooks.options.totalPnlUsd).toBeDefined();
      expect(snap.sleeveBooks.ownership.dailyPnlUsd).toBeDefined();
      expect(overlayCashReserved(snap.broker.positions)).toBe(0);
      expect(optionsFreeCash(snap.sleeveBooks.options.equityUsd, snap.broker.positions)).toBe(
        snap.sleeveBooks.options.equityUsd,
      );
    } finally {
      await srv.close();
      broker.reset();
    }
  });

  it("skips weeklies in defaults", async () => {
    const { app } = makeTestApp();
    stubMarket();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/csp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "options",
          symbol: "SPY",
          expiry: "2013-03-22",
          strike: 65,
          qty: 1,
          thesisSleeve: "ownership",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/weekl/i);
    } finally {
      await srv.close();
    }
  });

  it("GET /api/status includes daily and total P/L on every sleeve book", async () => {
    const { app } = makeTestApp();
    stubMarket();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/status`);
      expect(res.status).toBe(200);
      const snap = (await res.json()) as StatusSnapshot;
      for (const id of ["day", "momentum", "options", "ownership", "riskoff"] as const) {
        expect(snap.sleeveBooks[id].totalPnlUsd).toBe(
          snap.sleeveBooks[id].equityUsd - 100_000,
        );
        expect(typeof snap.sleeveBooks[id].dailyPnlUsd).toBe("number");
      }
      expect(typeof snap.riskOn).toBe("boolean");
      expect(snap.riskChecks).toMatchObject({
        spyAbove200: expect.any(Boolean),
        acwiAbove200: expect.any(Boolean),
        hygAbove200: expect.any(Boolean),
        dollarVeto: expect.any(Boolean),
      });
    } finally {
      await srv.close();
    }
  });
});

describe("overlay never hits a live broker", () => {
  it("overlay module and routes are paper-only", () => {
    const src = readFileSync(resolve("server/src/overlay.ts"), "utf8");
    expect(src).not.toMatch(/\/v1\/order/);
    expect(src).not.toMatch(/tradovate/i);
    const app = readFileSync(resolve("server/src/app.ts"), "utf8");
    expect(app).toMatch(/\/api\/paper\/csp/);
    expect(app).toMatch(/\/api\/paper\/covered-call/);
    expect(app).not.toMatch(/createTradovateFromEnv/);
    const auto = readFileSync(resolve("server/src/autopilot.ts"), "utf8");
    expect(auto).not.toMatch(/\/api\/paper\/csp/);
    expect(auto).not.toMatch(/\/api\/paper\/covered-call/);
    expect(auto).not.toMatch(/placePaperOverlay/);
  });
});
