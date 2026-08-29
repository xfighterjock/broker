import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedEvents } from "../shared/clock";
import type { CalendarEvent, OptionLeg, ScanRow, StatusSnapshot } from "../shared/types";
import { defaultSleeves } from "../shared/types";
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
import { resetEtradeCache } from "../server/src/etrade";
import {
  decideCallVerticalIntents,
  decidePutVerticalIntents,
  pickAtmPutDebit,
  runAutopilot,
} from "../server/src/autopilot";
import { setPaperNow, validateDebitVertical } from "../server/src/vertical";

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

function putLeg(strike: number, bid: number, ask: number, extra: Partial<OptionLeg> = {}): OptionLeg {
  return {
    underlying: extra.underlying ?? "SPY",
    osiKey: extra.osiKey ?? `O:SPY261009P${String(strike * 1000).padStart(8, "0")}`,
    displaySymbol: extra.displaySymbol ?? `SPY P ${strike}`,
    right: "P",
    strike,
    expiry: extra.expiry ?? "2026-10-09",
    bid,
    ask,
    last: (bid + ask) / 2,
    bidSize: 1,
    askSize: 1,
    openInterest: 10,
    delta: extra.delta ?? -0.4,
    gamma: 0.01,
    theta: -0.02,
    vega: 0.1,
    iv: 0.2,
  };
}

function callLeg(strike: number, bid: number, ask: number): OptionLeg {
  return {
    ...putLeg(strike, bid, ask),
    right: "C",
    osiKey: `O:SPY261009C${String(strike * 1000).padStart(8, "0")}`,
    displaySymbol: `SPY C ${strike}`,
    delta: 0.4,
  };
}

function scanRow(symbol: string, extra: Partial<ScanRow> = {}): ScanRow {
  return {
    symbol,
    name: symbol,
    sector: "Information Technology",
    last: 100,
    pctFrom52: -0.02,
    dist20: 0.01,
    above200: true,
    ret3m: 0.1,
    ret6m: 0.2,
    ret12m: 0.3,
    rs3m: 0.05,
    volx: 1,
    score: 0.22,
    why: "above 200 · pullback 20dma",
    ...extra,
  };
}

describe("put debit sizes from a two-strike mock chain", () => {
  it("sizes a put debit on two put strikes with bid/ask", () => {
    const long = putLeg(500, 6.1, 6.3);
    const short = putLeg(490, 3.4, 3.6);
    const v = validateDebitVertical({ long, short, quoteSymbol: "SPY" }, 100_000);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    // debit 6.3-3.4=2.9 → $290/ct. 1% of 100k = 1000 → 3 contracts.
    expect(v.netDebitPerShare).toBeCloseTo(2.9);
    expect(v.qty).toBe(3);
    expect(v.maxLoss).toBeCloseTo(870);
    expect(v.right).toBe("P");
    expect(v.long.strike).toBe(500);
    expect(v.short.strike).toBe(490);
  });

  it("pickAtmPutDebit longs the higher ATM put and shorts further OTM", () => {
    const pair = pickAtmPutDebit(
      [putLeg(490, 3.4, 3.6), putLeg(500, 6.1, 6.3), callLeg(500, 5, 5.2)],
      500,
    );
    expect(pair).not.toBeNull();
    expect(pair?.long.strike).toBe(500);
    expect(pair?.short.strike).toBe(490);
    expect(pair?.long.right).toBe("P");
    expect(pair?.short.right).toBe("P");
  });
});

describe("decidePutVerticalIntents", () => {
  const quotes = [
    { symbol: "SPY", last: 500 },
    { symbol: "QQQ", last: 400 },
    { symbol: "AAPL", last: 200 },
  ];

  it("returns [] when risk-on", () => {
    const intents = decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, true);
    expect(intents).toEqual([]);
  });

  it("returns [] on the options sleeve even when risk-off", () => {
    const intents = decidePutVerticalIntents(quotes, [], defaultSleeves().options, false);
    expect(intents).toEqual([]);
  });

  it("returns SPY/QQQ put intents when risk-off, never single names", () => {
    const intents = decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, false);
    expect(intents.map((i) => i.symbol)).toEqual(["SPY", "QQQ"]);
    expect(intents.every((i) => i.sleeveId === "riskoff")).toBe(true);
  });

  it("options auto never emits put intents; riskoff auto never emits call intents", () => {
    const calls = decideCallVerticalIntents(
      [scanRow("SPY"), scanRow("AAPL")],
      [],
      defaultSleeves().options,
      true,
    );
    expect(calls.every((i) => i.sleeveId === "options")).toBe(true);
    const putsOff = decidePutVerticalIntents(quotes, [], defaultSleeves().options, false);
    expect(putsOff).toEqual([]);
    const putsOnRiskoff = decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, false);
    expect(putsOnRiskoff.every((i) => i.sleeveId === "riskoff")).toBe(true);
    const callsOnRiskoff = decideCallVerticalIntents(
      [scanRow("SPY")],
      [],
      defaultSleeves().riskoff,
      true,
    );
    expect(callsOnRiskoff).toEqual([]);
  });
});

describe("runAutopilot risk-off puts vs risk-on calls", () => {
  beforeEach(() => setPaperNow(new Date("2026-08-24T14:00:00Z")));
  afterEach(() => setPaperNow(null));

  const putChain: OptionLeg[] = [
    putLeg(500, 6.1, 6.3),
    putLeg(490, 3.4, 3.6),
    callLeg(500, 5.1, 5.2),
    callLeg(510, 2.4, 2.5),
  ];

  it("risk-off opens put verticals on riskoff, never calls", async () => {
    const rights: string[] = [];
    const sleeves: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [scanRow("AAPL", { last: 67 })],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
      ],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v) => {
        rights.push(v.right);
        sleeves.push(v.sleeveId);
        expect(v.right).toBe("P");
        expect(v.sleeveId).toBe("riskoff");
        return { ok: true };
      },
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async () => putChain,
      log: () => {},
    });
    expect(rights).toEqual(["P", "P"]);
    expect(sleeves).toEqual(["riskoff", "riskoff"]);
    expect(result.verticals.every((v) => v.right === "P" && v.sleeveId === "riskoff")).toBe(true);
    expect(result.verticals.map((v) => v.symbol).sort()).toEqual(["QQQ", "SPY"]);
    expect(result.bought).toEqual([]);
  });

  it("risk-on does not open riskoff puts", async () => {
    const placed: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: true,
      riskoffQuotes: [{ symbol: "SPY", last: 500 }],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v) => {
        placed.push(`${v.sleeveId}:${v.right}:${v.symbol}`);
        return { ok: true };
      },
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async () => putChain,
      log: () => {},
    });
    expect(placed).toEqual([]);
    expect(result.verticals).toEqual([]);
  });
});

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
}

describe("HTTP riskoff put vertical (mocked E*TRADE chain)", () => {
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

  it("POST /api/paper/vertical accepts sleeveId riskoff for a put debit", async () => {
    const { app, broker } = makeTestApp();
    stubMarketFetch({ lastBySymbol: { SPY: 500, QQQ: 400 } });
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/vertical`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "riskoff",
          symbol: "SPY",
          right: "P",
          expiry: "2013-03-16",
          longStrike: 70,
          shortStrike: 65,
          qty: 1,
          thesis: "risk-off put debit",
          asOf: "2013-02-01T15:00:00.000Z",
        }),
      });
      expect(res.status).toBe(200);
      const snap = (await res.json()) as StatusSnapshot;
      const pos = snap.broker.positions.find((p) => p.side !== "Flat");
      expect(pos?.sleeveId).toBe("riskoff");
      expect(pos?.vertical?.kind).toBe("debit-vertical");
      expect(pos?.vertical?.right).toBe("P");
      expect(snap.sleeveBooks.riskoff.equityUsd).toBeGreaterThan(0);
      expect(broker.getPositionsSync().some((p) => p.sleeveId === "riskoff" && p.vertical)).toBe(true);
    } finally {
      await srv.close();
      broker.reset();
    }
  });

  it("refuses a call vertical on the riskoff sleeve", async () => {
    const { app } = makeTestApp();
    stubMarketFetch({ lastBySymbol: { SPY: 500 } });
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/vertical`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "riskoff",
          symbol: "SPY",
          right: "C",
          expiry: "2013-03-16",
          longStrike: 65,
          shortStrike: 70,
          qty: 1,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/put debit|no calls/i);
    } finally {
      await srv.close();
    }
  });
});
