import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedEvents } from "../shared/clock";
import type { CalendarEvent, OptionLeg, Position, ScanRow, StatusSnapshot } from "../shared/types";
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
  decideRiskoffPutSells,
  pickAtmPutDebit,
  runAutopilot,
  type AutoBuy,
  type AutoSell,
} from "../server/src/autopilot";
import {
  DEFAULT_SLEEVE_EQUITY_USD,
  RISKOFF_ETF_CANDIDATES,
  RISKOFF_ETF_CTA_FAMILY,
  RISKOFF_ETF_LOOKBACK_DAYS,
  RISKOFF_ETF_NOTIONAL_FRAC,
  RISKOFF_ETF_REQUIRE_ABOVE_200,
  RISKOFF_ETF_RS_HYSTERESIS,
  RISKOFF_ETF_STOP_MUL,
  RISKOFF_ETF_SYMBOLS,
  SLEEVE_IDS,
  type RiskoffEtfSymbol,
} from "../shared/constants";
import {
  above200FromCloses,
  decideRiskoffEtf,
  emptyRiskoffEtfAbove200,
  emptyRiskoffEtfReturns,
  isRiskoffEtfCta,
  periodReturn,
  pickRiskoffEtfSecond,
  pickRiskoffEtfSleeve,
  pickRiskoffEtfWinner,
  riskoffEtfAbove200FromBars,
  riskoffEtfQualifiers,
  riskoffEtfSleeveFrac,
  sizeRiskoffEtfShares,
  type RiskoffEtfAbove200,
  type RiskoffEtfReturns,
} from "../server/src/riskoffEtf";
import { sleeveBook } from "../server/src/paper";
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
    bidSize: extra.bidSize ?? 500,
    askSize: extra.askSize ?? 500,
    openInterest: extra.openInterest ?? 500,
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
    { symbol: "HYG", last: 77 },
    { symbol: "AAPL", last: 200 },
  ];

  it("returns [] when risk-on", () => {
    const intents = decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, true, {
      spyAbove200: false,
      hygAbove200: false,
    });
    expect(intents).toEqual([]);
  });

  it("returns [] on the options sleeve even when risk-off and both 200dma checks are false", () => {
    const intents = decidePutVerticalIntents(quotes, [], defaultSleeves().options, false, {
      spyAbove200: false,
      hygAbove200: false,
    });
    expect(intents).toEqual([]);
  });

  it("returns SPY/QQQ put intents when risk-off and SPY is below 200dma, never single names", () => {
    const intents = decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, false, {
      spyAbove200: false,
    });
    expect(intents.map((i) => i.symbol)).toEqual(["SPY", "QQQ"]);
    expect(intents.every((i) => i.sleeveId === "riskoff")).toBe(true);
  });

  it("HYG-only / credit-only OFF (SPY still above 200dma) does not open a credit-leg put", () => {
    const intents = decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, false, {
      spyAbove200: true,
      hygAbove200: false,
    });
    expect(intents).toEqual([]);
  });

  it("returns [] when spyAbove200 and hygAbove200 are missing (fail closed)", () => {
    const intents = decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, false);
    expect(intents).toEqual([]);
  });

  it("returns [] for HYG when hygAbove200 is missing even if SPY puts are allowed", () => {
    const intents = decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, false, {
      spyAbove200: false,
    });
    expect(intents.map((i) => i.symbol)).toEqual(["SPY", "QQQ"]);
    expect(intents.some((i) => i.symbol === "HYG")).toBe(false);
  });

  it("prefers HYG first then SPY/QQQ when both gates fire, inside the auto cap", () => {
    const intents = decidePutVerticalIntents(
      [...quotes, { symbol: "IWM", last: 200 }],
      [],
      defaultSleeves().riskoff,
      false,
      { spyAbove200: false, hygAbove200: false },
    );
    expect(intents.map((i) => i.symbol)).toEqual(["HYG", "SPY", "QQQ"]);
  });

  it("blocks LQD/JNK in HYG-only OFF; full OFF still uses own-200", () => {
    const creditQuotes = [
      ...quotes,
      { symbol: "LQD", last: 108 },
      { symbol: "JNK", last: 76 },
    ];
    expect(
      decidePutVerticalIntents(creditQuotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: true,
        hygAbove200: true,
        lqdAbove200: false,
      }).map((i) => i.symbol),
    ).toEqual([]);
    expect(
      decidePutVerticalIntents(creditQuotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: true,
        hygAbove200: true,
        jnkAbove200: false,
      }).map((i) => i.symbol),
    ).toEqual([]);
    expect(
      decidePutVerticalIntents(creditQuotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: false,
        hygAbove200: true,
        lqdAbove200: false,
      }).map((i) => i.symbol),
    ).toEqual(["LQD", "SPY", "QQQ"]);
    expect(
      decidePutVerticalIntents(creditQuotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: false,
        hygAbove200: true,
        lqdAbove200: true,
        jnkAbove200: false,
      }).map((i) => i.symbol),
    ).toEqual(["JNK", "SPY", "QQQ"]);
    expect(
      decidePutVerticalIntents(creditQuotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: false,
        hygAbove200: true,
        lqdAbove200: true,
        jnkAbove200: true,
      }).map((i) => i.symbol),
    ).toEqual(["SPY", "QQQ"]);
  });

  it("blocks LQD/JNK when own 200dma is missing or above; fill order HYG then LQD then JNK", () => {
    const creditQuotes = [
      ...quotes,
      { symbol: "LQD", last: 108 },
      { symbol: "JNK", last: 76 },
      { symbol: "IWM", last: 200 },
    ];
    expect(
      decidePutVerticalIntents(creditQuotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: false,
        hygAbove200: false,
        lqdAbove200: true,
        jnkAbove200: false,
      }).map((i) => i.symbol),
    ).toEqual(["HYG", "JNK", "SPY"]);
    expect(
      decidePutVerticalIntents(creditQuotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: false,
        hygAbove200: false,
      }).map((i) => i.symbol),
    ).toEqual(["HYG", "SPY", "QQQ"]);
    expect(
      decidePutVerticalIntents(creditQuotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: true,
        hygAbove200: false,
        lqdAbove200: true,
        jnkAbove200: false,
      }).map((i) => i.symbol),
    ).toEqual([]);
    expect(
      decidePutVerticalIntents(creditQuotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: false,
        hygAbove200: false,
        lqdAbove200: false,
        jnkAbove200: false,
      }).map((i) => i.symbol),
    ).toEqual(["HYG", "LQD", "JNK"]);
  });

  it("options auto never emits put intents; riskoff auto never emits call intents", () => {
    const calls = decideCallVerticalIntents(
      [scanRow("SPY"), scanRow("AAPL")],
      [],
      defaultSleeves().options,
      true,
    );
    expect(calls.every((i) => i.sleeveId === "options")).toBe(true);
    const putsOff = decidePutVerticalIntents(quotes, [], defaultSleeves().options, false, {
      spyAbove200: false,
      hygAbove200: false,
    });
    expect(putsOff).toEqual([]);
    const putsOnRiskoff = decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, false, {
      spyAbove200: false,
      hygAbove200: false,
    });
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
  beforeEach(() => setPaperNow(new Date("2026-09-03T13:50:00.000Z")));
  afterEach(() => setPaperNow(null));

  const putChain: OptionLeg[] = [
    putLeg(500, 6.1, 6.3),
    putLeg(490, 3.4, 3.6),
    callLeg(500, 5.1, 5.2),
    callLeg(510, 2.4, 2.5),
  ];

  it("risk-off opens put verticals on riskoff when SPY is below 200dma, never calls", async () => {
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
      riskChecks: { spyAbove200: false },
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

  it("when SPY and HYG are both below 200, HYG is first then SPY/QQQ inside the cap", async () => {
    const placed: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false, hygAbove200: false },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "IWM", last: 200 },
        { symbol: "HYG", last: 77 },
      ],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v) => {
        placed.push(v.symbol);
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
    expect(placed).toEqual(["HYG", "SPY", "QQQ"]);
    expect(result.verticals.map((v) => v.symbol)).toEqual(["HYG", "SPY", "QQQ"]);
    expect(result.verticals[0].thesis).toMatch(/credit-leg/);
  });

  it("HYG-only OFF (SPY still above 200) does not open the HYG credit-leg put", async () => {
    const placed: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [scanRow("AAPL", { last: 67 })],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: true, hygAbove200: false },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "HYG", last: 77 },
      ],
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v) => {
        placed.push(`${v.sleeveId}:${v.right}:${v.symbol}`);
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
    expect(placed).toEqual([]);
    expect(result.verticals).toEqual([]);
    expect(result.bought).toEqual([]);
  });

  it("missing hygAbove200 fails closed: no HYG put on credit-only OFF", async () => {
    const placed: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [scanRow("AAPL", { last: 67 })],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: true },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "HYG", last: 77 },
      ],
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
    expect(result.bought).toEqual([]);
  });

  it("missing spyAbove200 fails closed: no new equity-index or credit-leg puts", async () => {
    const placed: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { hygAbove200: false, lqdAbove200: false, jnkAbove200: false },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "HYG", last: 77 },
        { symbol: "LQD", last: 108 },
        { symbol: "JNK", last: 76 },
      ],
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

  it("POST /api/paper/order accepts GLD on riskoff and refuses other stock names", async () => {
    const { app, broker } = makeTestApp();
    stubMarketFetch({ lastBySymbol: { GLD: 180, SPY: 500, TLT: 90, DBMF: 28, KMLM: 27 } });
    const srv = await listen(app);
    try {
      const gld = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "riskoff",
          symbol: "GLD",
          side: "Buy",
          qty: 10,
          stopPrice: 165,
          thesis: "manual GLD",
        }),
      });
      expect(gld.status).toBe(200);
      const snap = (await gld.json()) as StatusSnapshot;
      const pos = snap.broker.positions.find((p) => p.symbol === "GLD" && p.side !== "Flat");
      expect(pos?.sleeveId).toBe("riskoff");
      expect(pos?.qty).toBe(10);
      expect(pos?.vertical).toBeUndefined();
      expect(snap.sleeveBooks.riskoff.equityUsd).toBeGreaterThan(0);

      const spy = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "riskoff",
          symbol: "SPY",
          side: "Buy",
          qty: 1,
          stopPrice: 400,
          thesis: "not an etf expression",
        }),
      });
      expect(spy.status).toBe(400);
      const body = (await spy.json()) as { error: string };
      expect(body.error).toMatch(/GLD\/UUP\/TLT\/IEF\/XLU\/XLP\/DBMF\/KMLM\/BIL|put debit/i);

      const tlt = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "riskoff",
          symbol: "TLT",
          side: "Buy",
          qty: 5,
          stopPrice: 80,
          thesis: "manual TLT",
        }),
      });
      expect(tlt.status).toBe(200);

      const dbmf = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "riskoff",
          symbol: "DBMF",
          side: "Buy",
          qty: 5,
          stopPrice: 25,
          thesis: "manual DBMF",
        }),
      });
      expect(dbmf.status).toBe(200);

      const kmlm = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "riskoff",
          symbol: "KMLM",
          side: "Buy",
          qty: 5,
          stopPrice: 24,
          thesis: "manual KMLM",
        }),
      });
      expect(kmlm.status).toBe(200);

      const lqd = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "riskoff",
          symbol: "LQD",
          side: "Buy",
          qty: 1,
          stopPrice: 100,
          thesis: "phase 2 credit name",
        }),
      });
      expect(lqd.status).toBe(400);
    } finally {
      await srv.close();
      broker.reset();
    }
  });
});

function etfPos(symbol: string, qty: number, avg = 100): Position {
  return {
    id: `etf-${symbol}`,
    symbol,
    root: null,
    qty,
    side: "Long",
    avgPrice: avg,
    unrealizedPnl: 0,
    gated: false,
    sleeveId: "riskoff",
  };
}

function putVertPos(underlying: string): Position {
  const expiry = "2026-10-09";
  const longStrike = 500;
  const shortStrike = 490;
  return {
    id: `vert-${underlying}`,
    symbol: `${underlying} ${longStrike}/${shortStrike} P ${expiry}`,
    root: null,
    qty: 1,
    side: "Long",
    avgPrice: 2.9,
    unrealizedPnl: 0,
    gated: false,
    sleeveId: "riskoff",
    vertical: {
      kind: "debit-vertical",
      right: "P",
      expiry,
      underlying,
      quoteSymbol: underlying,
      qty: 1,
      long: putLeg(longStrike, 6.1, 6.3, { underlying }),
      short: putLeg(shortStrike, 3.4, 3.6, { underlying }),
      longFill: 6.3,
      shortFill: 3.4,
      netDebitPerShare: 2.9,
      netDebitPaid: 290,
      maxLoss: 290,
      maxProfit: 710,
      width: 10,
      openedAt: "2026-08-24T14:00:00Z",
      asOf: "2026-08-24T14:00:00Z",
    },
  };
}

function etfQuotes(lasts: Record<string, number>) {
  return Object.entries(lasts).map(([symbol, last]) => ({ symbol, last }));
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

function etfAbove200(
  overrides: Partial<Record<RiskoffEtfSymbol, boolean | null>> = {},
): RiskoffEtfAbove200 {
  const out = emptyRiskoffEtfAbove200();
  for (const s of RISKOFF_ETF_SYMBOLS) out[s] = s === "BIL" ? null : true;
  for (const [k, v] of Object.entries(overrides) as Array<[RiskoffEtfSymbol, boolean | null]>) {
    out[k] = v;
  }
  return out;
}

const gldWins = etfRs({ GLD: 0.12 });
const uupWins = etfRs({ UUP: 0.11 });
const bothTrail = etfRs({ GLD: -0.02, UUP: -0.04 });
const tltWins = etfRs({ TLT: 0.14 });
const iefWins = etfRs({ IEF: 0.13 });
const xluWins = etfRs({ XLU: 0.12 });
const xlpWins = etfRs({ XLP: 0.11 });
const dbmfWins = etfRs({ DBMF: 0.15 });
const kmlmWins = etfRs({ KMLM: 0.16 });
const allEtfQuotes = etfQuotes({
  GLD: 180,
  UUP: 28,
  TLT: 90,
  IEF: 95,
  XLU: 70,
  XLP: 80,
  DBMF: 28,
  KMLM: 27,
  BIL: 91,
});

function paperBook(initial: Position[] = []) {
  let positions = initial.map((p) => ({ ...p }));
  return {
    getPositions: () => positions,
    place: async (b: AutoBuy) => {
      positions = [
        ...positions.filter(
          (p) => !(p.sleeveId === b.sleeveId && p.symbol.toUpperCase() === b.symbol.toUpperCase()),
        ),
        etfPos(b.symbol, b.qty, 100),
      ];
      return { ok: true as const };
    },
    close: async (s: AutoSell) => {
      positions = positions.filter(
        (p) =>
          !(p.sleeveId === s.sleeveId && p.symbol.toUpperCase() === s.symbol.toUpperCase()),
      );
      return { ok: true as const };
    },
  };
}

const putChainForAuto: OptionLeg[] = [
  putLeg(500, 6.1, 6.3),
  putLeg(490, 3.4, 3.6),
  callLeg(500, 5.1, 5.2),
  callLeg(510, 2.4, 2.5),
];

describe("risk-off ETF relative-strength expression", () => {
  beforeEach(() => setPaperNow(new Date("2026-09-03T13:50:00.000Z")));
  afterEach(() => setPaperNow(null));
  it("uses a 63-session lookback and fails closed without an exact series", () => {
    expect(RISKOFF_ETF_LOOKBACK_DAYS).toBe(63);
    const closes = Array.from({ length: 80 }, () => 100);
    closes[closes.length - 1] = 110;
    expect(periodReturn(closes, 63)).toBeCloseTo(0.1);
    expect(periodReturn(closes.slice(-63), 63)).toBeNull();
    expect(periodReturn([], 63)).toBeNull();
  });

  it("uses 40% book notional and does not loosen the disaster stop", () => {
    expect(RISKOFF_ETF_NOTIONAL_FRAC).toBe(0.4);
    expect(DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC).toBe(40_000);
    expect(RISKOFF_ETF_STOP_MUL).toBe(0.92);
    expect(RISKOFF_ETF_LOOKBACK_DAYS).toBe(63);
    expect(RISKOFF_ETF_REQUIRE_ABOVE_200).toBe(true);
    const qty = sizeRiskoffEtfShares(180);
    expect(qty).toBe(Math.floor((DEFAULT_SLEEVE_EQUITY_USD * 0.4) / 180));
    expect(qty * 180).toBeLessThanOrEqual(DEFAULT_SLEEVE_EQUITY_USD * 0.4);
    const decided = decideRiskoffEtf({
      riskOn: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: gldWins,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(decided.buy?.symbol).toBe("GLD");
    expect(decided.buy?.qty).toBe(qty);
    expect(decided.buy?.stopPrice).toBeCloseTo(180 * 0.92);
  });

  it("picks GLD or UUP only when that name beats BIL", () => {
    expect(pickRiskoffEtfWinner(gldWins)).toBe("GLD");
    expect(pickRiskoffEtfWinner(uupWins)).toBe("UUP");
    expect(pickRiskoffEtfWinner(bothTrail)).toBe("BIL");
    expect(pickRiskoffEtfWinner(etfRs({ GLD: null, UUP: 0.2 }))).toBeNull();
  });

  it("ranks TLT/IEF/XLU/XLP/DBMF/KMLM when they beat BIL and the rest of the sleeve", () => {
    expect(pickRiskoffEtfWinner(tltWins)).toBe("TLT");
    expect(pickRiskoffEtfWinner(iefWins)).toBe("IEF");
    expect(pickRiskoffEtfWinner(xluWins)).toBe("XLU");
    expect(pickRiskoffEtfWinner(xlpWins)).toBe("XLP");
    expect(pickRiskoffEtfWinner(dbmfWins)).toBe("DBMF");
    expect(pickRiskoffEtfWinner(kmlmWins)).toBe("KMLM");
    expect(RISKOFF_ETF_CANDIDATES).toEqual(["GLD", "UUP", "TLT", "IEF", "XLU", "XLP", "DBMF", "KMLM"]);
    expect(RISKOFF_ETF_SYMBOLS).toEqual(["GLD", "UUP", "TLT", "IEF", "XLU", "XLP", "DBMF", "KMLM", "BIL"]);
    expect(RISKOFF_ETF_CTA_FAMILY).toEqual(["DBMF", "KMLM"]);
    expect(RISKOFF_ETF_SYMBOLS).toContain("KMLM");
  });

  it("keeps the held name on an exact RS tie if it is still eligible, else GLD > UUP > duration > defensives > trend", () => {
    const gldTltTie = etfRs({ GLD: 0.1, TLT: 0.1, UUP: 0.04 });
    expect(pickRiskoffEtfWinner(gldTltTie, "TLT")).toBe("TLT");
    expect(pickRiskoffEtfWinner(gldTltTie)).toBe("GLD");
    const durationTie = etfRs({ TLT: 0.1, IEF: 0.1, GLD: 0.02 });
    expect(pickRiskoffEtfWinner(durationTie, "IEF")).toBe("IEF");
    expect(pickRiskoffEtfWinner(durationTie)).toBe("TLT");
    const defensiveTie = etfRs({ XLU: 0.1, XLP: 0.1, GLD: 0.02 });
    expect(pickRiskoffEtfWinner(defensiveTie, "XLP")).toBe("XLP");
    expect(pickRiskoffEtfWinner(defensiveTie)).toBe("XLU");
    const trendTie = etfRs({ XLP: 0.1, DBMF: 0.1, GLD: 0.02 });
    expect(pickRiskoffEtfWinner(trendTie, "DBMF")).toBe("DBMF");
    expect(pickRiskoffEtfWinner(trendTie)).toBe("XLP");
    const ctaTie = etfRs({ DBMF: 0.1, KMLM: 0.1, GLD: 0.02 });
    expect(pickRiskoffEtfWinner(ctaTie, "KMLM")).toBe("KMLM");
    expect(pickRiskoffEtfWinner(ctaTie)).toBe("DBMF");
    const gldUupTie = etfRs({ GLD: 0.1, UUP: 0.1 });
    expect(pickRiskoffEtfWinner(gldUupTie, "UUP")).toBe("UUP");
    expect(pickRiskoffEtfWinner(gldUupTie)).toBe("GLD");
  });

  it("keeps held GLD when DBMF leads by less than RISKOFF_ETF_RS_HYSTERESIS", () => {
    expect(RISKOFF_ETF_RS_HYSTERESIS).toBe(0.005);
    const dbmfTinyLead = etfRs({ GLD: 0.1, DBMF: 0.104 });
    expect(0.104 - 0.1).toBeLessThan(RISKOFF_ETF_RS_HYSTERESIS);
    expect(pickRiskoffEtfWinner(dbmfTinyLead, "GLD")).toBe("GLD");
    const hold = decideRiskoffEtf({
      riskOn: false,
      positions: [etfPos("GLD", 100, 180)],
      sleeve: defaultSleeves().riskoff,
      returns: dbmfTinyLead,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(hold.winner).toBe("GLD");
    expect(hold.winners).toEqual(["GLD", "DBMF"]);
    expect(hold.sells).toEqual([]);
    expect(hold.buy?.symbol).toBe("DBMF");
    expect(hold.reason).toBe("buy GLD+DBMF");
  });

  it("rotates GLD to DBMF when DBMF leads by RISKOFF_ETF_RS_HYSTERESIS or more", () => {
    const dbmfClearLead = etfRs({ GLD: 0.1, DBMF: 0.106 });
    expect((dbmfClearLead.DBMF as number) - (dbmfClearLead.GLD as number)).toBeGreaterThanOrEqual(
      RISKOFF_ETF_RS_HYSTERESIS,
    );
    expect(pickRiskoffEtfWinner(dbmfClearLead, "GLD")).toBe("DBMF");
    const rotate = decideRiskoffEtf({
      riskOn: false,
      positions: [etfPos("GLD", 100, 180)],
      sleeve: defaultSleeves().riskoff,
      returns: dbmfClearLead,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(rotate.winner).toBe("DBMF");
    expect(rotate.winners).toEqual(["DBMF", "GLD"]);
    expect(rotate.sells.map((s) => s.symbol)).toEqual([]);
    expect(rotate.buy?.symbol).toBe("DBMF");
    expect(rotate.buy?.thesis).toMatch(/top-2 DBMF\+GLD/);
  });

  it("does not apply RS hysteresis when held is ineligible or missing", () => {
    const heldBelowBil = etfRs({ GLD: 0.009, DBMF: 0.012 });
    expect(heldBelowBil.GLD).toBeLessThanOrEqual(heldBelowBil.BIL as number);
    expect((heldBelowBil.DBMF as number) - (heldBelowBil.GLD as number)).toBeLessThan(
      RISKOFF_ETF_RS_HYSTERESIS,
    );
    expect(pickRiskoffEtfWinner(heldBelowBil, "GLD")).toBe("DBMF");
    const noHeldCloseRace = etfRs({ GLD: 0.1, DBMF: 0.104 });
    expect(pickRiskoffEtfWinner(noHeldCloseRace)).toBe("DBMF");
    expect(pickRiskoffEtfWinner(noHeldCloseRace, null)).toBe("DBMF");
    const exactTie = etfRs({ GLD: 0.1, DBMF: 0.1 });
    expect(pickRiskoffEtfWinner(exactTie, "GLD")).toBe("GLD");
    expect(pickRiskoffEtfWinner(exactTie, "DBMF")).toBe("DBMF");
  });

  it("computes 200dma from the same overlay closes and fails closed when short", () => {
    expect(above200FromCloses(Array.from({ length: 199 }, () => 100))).toBeNull();
    const flat = Array.from({ length: 200 }, () => 100);
    expect(above200FromCloses(flat)).toBe(false);
    const above = [...flat];
    above[above.length - 1] = 110;
    expect(above200FromCloses(above)).toBe(true);
    const below = [...flat];
    below[below.length - 1] = 90;
    expect(above200FromCloses(below)).toBe(false);
    const bars = { GLD: above.map((close) => ({ close, volume: 1 })) };
    expect(riskoffEtfAbove200FromBars(bars).GLD).toBe(true);
    expect(riskoffEtfAbove200FromBars(bars).UUP).toBeNull();
  });

  it("parks in BIL when no qualifier is above its 200dma; skips a failed-200 name if another qualifies", () => {
    expect(pickRiskoffEtfWinner(gldWins, null, etfAbove200({ GLD: false }))).toBe("BIL");
    const xlpAlsoEligible = etfRs({ GLD: 0.12, XLP: 0.08 });
    expect(pickRiskoffEtfWinner(xlpAlsoEligible)).toBe("GLD");
    expect(pickRiskoffEtfWinner(xlpAlsoEligible, null, etfAbove200({ GLD: false, XLP: true }))).toBe(
      "XLP",
    );
    const book = paperBook([etfPos("GLD", 100, 180)]);
    const decided = decideRiskoffEtf({
      riskOn: false,
      positions: book.getPositions(),
      sleeve: defaultSleeves().riskoff,
      returns: gldWins,
      quotes: allEtfQuotes,
      above200: etfAbove200({ GLD: false }),
    });
    expect(decided.winner).toBe("BIL");
    expect(decided.sells.map((s) => s.symbol)).toEqual(["GLD"]);
    expect(decided.buy?.symbol).toBe("BIL");
    expect(decided.buy?.symbol).not.toBe("GLD");
    expect(decided.reason).toBe("GLD below 200dma: overlay cash");
    expect(decided.buy?.thesis).toBe("GLD below 200dma: overlay cash");
  });

  it("keeps the RS winner when that name is above its 200dma, including hysteresis holds", () => {
    expect(pickRiskoffEtfWinner(gldWins, null, etfAbove200())).toBe("GLD");
    const dbmfTinyLead = etfRs({ GLD: 0.1, DBMF: 0.104 });
    expect(pickRiskoffEtfWinner(dbmfTinyLead, "GLD", etfAbove200())).toBe("GLD");
    const hold = decideRiskoffEtf({
      riskOn: false,
      positions: [etfPos("GLD", 100, 180)],
      sleeve: defaultSleeves().riskoff,
      returns: gldWins,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(hold.winner).toBe("GLD");
    expect(hold.reason).toBe("hold GLD");
    expect(hold.buy).toBeNull();
    expect(hold.sells).toEqual([]);
  });

  it("parks in BIL when the winner's 200dma is missing", () => {
    expect(pickRiskoffEtfWinner(gldWins, null, etfAbove200({ GLD: null }))).toBe("BIL");
    expect(pickRiskoffEtfWinner(gldWins, null, emptyRiskoffEtfAbove200())).toBe("BIL");
    const decided = decideRiskoffEtf({
      riskOn: false,
      positions: [etfPos("GLD", 100, 180)],
      sleeve: defaultSleeves().riskoff,
      returns: gldWins,
      quotes: allEtfQuotes,
    });
    expect(decided.winner).toBe("BIL");
    expect(decided.sells.map((s) => s.symbol)).toEqual(["GLD"]);
    expect(decided.buy?.symbol).toBe("BIL");
    expect(decided.reason).toBe("GLD 200dma missing: overlay cash");
  });

  it("never 200-filters BIL as the RS cash benchmark", () => {
    expect(pickRiskoffEtfWinner(bothTrail, null, etfAbove200({ BIL: false }))).toBe("BIL");
    expect(pickRiskoffEtfWinner(bothTrail, null, etfAbove200({ BIL: null }))).toBe("BIL");
    const buyBil = decideRiskoffEtf({
      riskOn: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: bothTrail,
      quotes: allEtfQuotes,
      above200: etfAbove200({ BIL: false }),
    });
    expect(buyBil.winner).toBe("BIL");
    expect(buyBil.buy?.symbol).toBe("BIL");
    expect(buyBil.reason).toBe("buy BIL");
    expect(buyBil.buy?.thesis).toMatch(/winner BIL/);
    const holdBil = decideRiskoffEtf({
      riskOn: false,
      positions: [etfPos("BIL", 400, 91)],
      sleeve: defaultSleeves().riskoff,
      returns: bothTrail,
      quotes: allEtfQuotes,
      above200: etfAbove200({ BIL: false }),
    });
    expect(holdBil.winner).toBe("BIL");
    expect(holdBil.reason).toBe("hold BIL");
    expect(holdBil.buy).toBeNull();
  });

  it("autopilot: RS winner GLD below 200 → sell GLD, park in BIL, no GLD buy", async () => {
    const book = paperBook([etfPos("GLD", 100, 180)]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffEtfReturns: gldWins,
      riskoffEtfAbove200: etfAbove200({ GLD: false }),
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.sold.map((s) => s.symbol)).toEqual(["GLD"]);
    expect(result.bought.map((b) => b.symbol)).toEqual(["BIL"]);
    expect(result.bought.some((b) => b.symbol === "GLD")).toBe(false);
    expect(book.getPositions().map((p) => p.symbol)).toEqual(["BIL"]);
  });

  it("absolute trend drops a held name below 200dma and takes the next qualifier", () => {
    const dbmfTinyLead = etfRs({ GLD: 0.1, DBMF: 0.104 });
    expect(pickRiskoffEtfWinner(dbmfTinyLead, "GLD")).toBe("GLD");
    expect(pickRiskoffEtfWinner(dbmfTinyLead, "GLD", etfAbove200({ GLD: false }))).toBe("DBMF");
    const flatten = decideRiskoffEtf({
      riskOn: false,
      positions: [etfPos("GLD", 100, 180)],
      sleeve: defaultSleeves().riskoff,
      returns: dbmfTinyLead,
      quotes: allEtfQuotes,
      above200: etfAbove200({ GLD: false }),
    });
    expect(flatten.winner).toBe("DBMF");
    expect(flatten.winners).toEqual(["DBMF"]);
    expect(flatten.sells.map((s) => s.symbol)).toEqual(["GLD"]);
    expect(flatten.buy?.symbol).toBe("DBMF");
    expect(flatten.reason).toBe("buy DBMF");
  });

  it("sizes a 40% stake well under the $100k sleeve (short of half)", () => {
    const qty = sizeRiskoffEtfShares(180);
    expect(qty).toBe(Math.floor((DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC) / 180));
    expect(qty * 180).toBeGreaterThan(35_000);
    expect(qty * 180).toBeLessThan(50_000);
    expect(qty * 180).toBeLessThan(DEFAULT_SLEEVE_EQUITY_USD);
    const uupQty = sizeRiskoffEtfShares(28);
    expect(qty).toBeLessThan(uupQty);
    expect(uupQty * 28).toBeLessThanOrEqual(DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC);
    expect(SLEEVE_IDS).toHaveLength(5);
    expect(SLEEVE_IDS).toEqual(
      expect.arrayContaining(["day", "momentum", "options", "ownership", "riskoff"]),
    );
  });

  it("1. HYG-only OFF (SPY above 200, HYG below) → paper long GLD, no new credit-leg put", async () => {
    const book = paperBook();
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: true, hygAbove200: false },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "HYG", last: 77 },
      ],
      riskoffEtfReturns: gldWins,
      riskoffEtfAbove200: etfAbove200(),
      riskoffEtfQuotes: etfQuotes({ GLD: 180, UUP: 28, BIL: 91 }),
      place: book.place,
      close: book.close,
      placeVertical: async () => ({ ok: true }),
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async () => putChainForAuto,
      log: () => {},
    });
    const etfBuys = result.bought.filter((b) => b.sleeveId === "riskoff");
    expect(etfBuys).toHaveLength(1);
    expect(etfBuys[0].symbol).toBe("GLD");
    expect(etfBuys[0].qty).toBe(sizeRiskoffEtfShares(180));
    expect(etfBuys[0].qty * 180).toBeLessThanOrEqual(DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC);
    expect(book.getPositions().filter((p) => !p.vertical).map((p) => p.symbol)).toEqual(["GLD"]);
    expect(result.verticals).toEqual([]);
    const sleeves = defaultSleeves();
    const marked = sleeveBook(
      sleeves.riskoff,
      book.getPositions().map((p) => ({ ...p, unrealizedPnl: 50 })),
    );
    expect(marked.unrealizedPnlUsd).toBe(50);
    expect(Object.keys(defaultSleeves()).sort()).toEqual([...SLEEVE_IDS].sort());
  });

  it("1b. RISK OFF and SPY below 200dma → puts still fire; ETF still runs", async () => {
    const book = paperBook();
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
      ],
      riskoffEtfReturns: gldWins,
      riskoffEtfAbove200: etfAbove200(),
      riskoffEtfQuotes: etfQuotes({ GLD: 180, UUP: 28, BIL: 91 }),
      place: book.place,
      close: book.close,
      placeVertical: async () => ({ ok: true }),
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async () => putChainForAuto,
      log: () => {},
    });
    expect(result.bought.filter((b) => b.sleeveId === "riskoff").map((b) => b.symbol)).toEqual(["GLD"]);
    expect(result.verticals.every((v) => v.right === "P" && v.sleeveId === "riskoff")).toBe(true);
    expect(result.verticals.map((v) => v.symbol).sort()).toEqual(["QQQ", "SPY"]);
  });

  it("2b. TLT beats the rest of the sleeve → paper long TLT at the same notional", async () => {
    const book = paperBook();
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffEtfReturns: tltWins,
      riskoffEtfAbove200: etfAbove200(),
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.bought.map((b) => b.symbol)).toEqual(["TLT"]);
    expect(result.bought[0].qty).toBe(sizeRiskoffEtfShares(90));
    expect(result.bought[0].qty * 90).toBeLessThanOrEqual(DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC);
    expect(result.bought[0].stopPrice).toBeCloseTo(90 * RISKOFF_ETF_STOP_MUL);
    expect(book.getPositions().map((p) => p.symbol)).toEqual(["TLT"]);
  });

  it("2c. DBMF beats the rest of the sleeve → paper long DBMF at the same notional", async () => {
    const book = paperBook();
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffEtfReturns: dbmfWins,
      riskoffEtfAbove200: etfAbove200(),
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.bought.map((b) => b.symbol)).toEqual(["DBMF"]);
    expect(result.bought[0].qty).toBe(sizeRiskoffEtfShares(28));
    expect(result.bought[0].qty * 28).toBeLessThanOrEqual(DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC);
    expect(result.bought[0].stopPrice).toBeCloseTo(28 * RISKOFF_ETF_STOP_MUL);
    expect(book.getPositions().map((p) => p.symbol)).toEqual(["DBMF"]);
  });

  it("2. Winner flips to UUP → rotate, still one name", async () => {
    const book = paperBook([etfPos("GLD", 100, 180)]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffEtfReturns: uupWins,
      riskoffEtfAbove200: etfAbove200(),
      riskoffEtfQuotes: etfQuotes({ GLD: 180, UUP: 28, BIL: 91 }),
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.sold.map((s) => s.symbol)).toEqual(["GLD"]);
    expect(result.bought.map((b) => b.symbol)).toEqual(["UUP"]);
    expect(result.bought[0].qty).toBe(sizeRiskoffEtfShares(28));
    expect(result.bought[0].qty * 28).toBeLessThanOrEqual(
      DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC,
    );
    const etfs = book.getPositions().filter((p) => p.sleeveId === "riskoff" && !p.vertical);
    expect(etfs).toHaveLength(1);
    expect(etfs[0].symbol).toBe("UUP");
    expect(etfs[0].qty).toBe(sizeRiskoffEtfShares(28));

    const rotate = decideRiskoffEtf({
      riskOn: false,
      positions: [etfPos("GLD", 100, 180)],
      sleeve: defaultSleeves().riskoff,
      returns: uupWins,
      quotes: etfQuotes({ GLD: 180, UUP: 28, BIL: 91 }),
      above200: etfAbove200(),
    });
    expect(rotate.sells.map((s) => s.symbol)).toEqual(["GLD"]);
    expect(rotate.buy?.symbol).toBe("UUP");
    expect(rotate.buy?.qty).toBe(sizeRiskoffEtfShares(28));
    expect((rotate.buy?.qty ?? 0) * 28).toBeLessThanOrEqual(
      DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC,
    );
  });

  it("3. Both trail BIL → BIL or cash, not GLD/UUP", async () => {
    const book = paperBook([etfPos("GLD", 100, 180)]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffEtfReturns: bothTrail,
      riskoffEtfQuotes: etfQuotes({ GLD: 180, UUP: 28, BIL: 91 }),
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.sold.map((s) => s.symbol)).toEqual(["GLD"]);
    expect(result.bought.map((b) => b.symbol)).toEqual(["BIL"]);
    expect(book.getPositions().map((p) => p.symbol)).toEqual(["BIL"]);
    expect(book.getPositions().some((p) => p.symbol === "GLD" || p.symbol === "UUP")).toBe(false);

    const cashBook = paperBook([etfPos("GLD", 50, 180)]);
    const cash = await runAutopilot({
      enabled: true,
      getPositions: cashBook.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffEtfReturns: bothTrail,
      riskoffEtfQuotes: etfQuotes({ GLD: 180, UUP: 28 }),
      place: cashBook.place,
      close: cashBook.close,
      log: () => {},
    });
    expect(cash.bought).toEqual([]);
    expect(cash.sold.map((s) => s.symbol)).toEqual(["GLD"]);
    expect(cashBook.getPositions()).toEqual([]);
  });

  it("4. RISK ON → ETF flattened and HYG credit-leg put flattened; no new puts", async () => {
    const hygPut = putVertPos("HYG");
    const book = paperBook([etfPos("GLD", 100, 180), hygPut]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: true,
      riskChecks: { spyAbove200: true, hygAbove200: true },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "HYG", last: 77 },
      ],
      riskoffEtfReturns: gldWins,
      riskoffEtfAbove200: etfAbove200(),
      riskoffEtfQuotes: etfQuotes({ GLD: 180, UUP: 28, BIL: 91 }),
      place: book.place,
      close: book.close,
      placeVertical: async () => ({ ok: true }),
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async () => putChainForAuto,
      log: () => {},
    });
    expect(result.sold.map((s) => s.symbol).sort()).toEqual(["GLD", hygPut.symbol].sort());
    expect(result.bought.filter((b) => b.sleeveId === "riskoff")).toEqual([]);
    expect(result.verticals).toEqual([]);
    expect(book.getPositions()).toEqual([]);

    const quotes = [
      { symbol: "SPY", last: 500 },
      { symbol: "QQQ", last: 400 },
      { symbol: "HYG", last: 77 },
    ];
    expect(
      decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, false, { spyAbove200: false }).map(
        (i) => i.symbol,
      ),
    ).toEqual(["SPY", "QQQ"]);
    expect(decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, true, { spyAbove200: true })).toEqual(
      [],
    );
    expect(
      decidePutVerticalIntents(quotes, [], defaultSleeves().riskoff, false, {
        spyAbove200: true,
        hygAbove200: false,
      }).map((i) => i.symbol),
    ).toEqual([]);
  });

  it("5. Missing bars → fail closed to cash", async () => {
    const book = paperBook([etfPos("UUP", 200, 28)]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffEtfReturns: etfRs({ GLD: null, UUP: 0.2 }),
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.bought).toEqual([]);
    expect(result.sold.map((s) => s.symbol)).toEqual(["UUP"]);
    expect(book.getPositions()).toEqual([]);
    expect(pickRiskoffEtfWinner(etfRs({ GLD: null, UUP: 0.2 }))).toBeNull();
    expect(pickRiskoffEtfWinner(etfRs({ TLT: null, GLD: 0.2 }))).toBeNull();
    expect(pickRiskoffEtfWinner(etfRs({ DBMF: null, GLD: 0.2 }))).toBeNull();
    expect(pickRiskoffEtfWinner(etfRs({ KMLM: null, GLD: 0.2 }))).toBeNull();
  });

  it("6. Size stays ~$40k (well under $100k) and hold does not churn", async () => {
    const qty = sizeRiskoffEtfShares(180);
    expect(qty * 180).toBeLessThanOrEqual(DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC);
    const book = paperBook([etfPos("GLD", qty, 180)]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffEtfReturns: gldWins,
      riskoffEtfAbove200: etfAbove200(),
      riskoffEtfQuotes: etfQuotes({ GLD: 180, UUP: 28, BIL: 91 }),
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.bought).toEqual([]);
    expect(result.sold).toEqual([]);
    expect(book.getPositions()).toHaveLength(1);
    expect(qty * 180).toBeLessThan(DEFAULT_SLEEVE_EQUITY_USD);
    const decided = decideRiskoffEtf({
      riskOn: false,
      positions: book.getPositions(),
      sleeve: defaultSleeves().riskoff,
      returns: gldWins,
      quotes: etfQuotes({ GLD: 180, UUP: 28, BIL: 91 }),
      above200: etfAbove200(),
    });
    expect(decided.buy).toBeNull();
    expect(decided.winner).toBe("GLD");

    const oldQty = Math.floor((DEFAULT_SLEEVE_EQUITY_USD * 0.2) / 180);
    expect(oldQty).toBeLessThan(qty);
    const holdOld = decideRiskoffEtf({
      riskOn: false,
      positions: [etfPos("GLD", oldQty, 180)],
      sleeve: defaultSleeves().riskoff,
      returns: gldWins,
      quotes: etfQuotes({ GLD: 180, UUP: 28, BIL: 91 }),
      above200: etfAbove200(),
    });
    expect(holdOld.buy).toBeNull();
    expect(holdOld.sells).toEqual([]);
    expect(holdOld.winner).toBe("GLD");
  });

  it("2d. KMLM beats the rest of the sleeve → paper long KMLM at the same notional", async () => {
    const book = paperBook();
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffEtfReturns: kmlmWins,
      riskoffEtfAbove200: etfAbove200(),
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.bought.map((b) => b.symbol)).toEqual(["KMLM"]);
    expect(result.bought[0].qty).toBe(sizeRiskoffEtfShares(27));
    expect(result.bought[0].qty * 27).toBeLessThanOrEqual(DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC);
    expect(result.bought[0].stopPrice).toBeCloseTo(27 * RISKOFF_ETF_STOP_MUL);
    expect(book.getPositions().map((p) => p.symbol)).toEqual(["KMLM"]);
  });

  it("top-2 equal-weight: two qualifiers split the 40% overlay 50/50", async () => {
    const two = etfRs({ GLD: 0.12, UUP: 0.08 });
    expect(riskoffEtfQualifiers(two, etfAbove200())).toEqual(["GLD", "UUP"]);
    expect(pickRiskoffEtfSleeve(two, null, etfAbove200())).toEqual(["GLD", "UUP"]);
    expect(riskoffEtfSleeveFrac(2)).toBe(RISKOFF_ETF_NOTIONAL_FRAC / 2);
    const decided = decideRiskoffEtf({
      riskOn: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: two,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(decided.winners).toEqual(["GLD", "UUP"]);
    expect(decided.buys.map((b) => b.symbol)).toEqual(["GLD", "UUP"]);
    expect(decided.buy?.symbol).toBe("GLD");
    const gldQty = sizeRiskoffEtfShares(180, DEFAULT_SLEEVE_EQUITY_USD, riskoffEtfSleeveFrac(2));
    const uupQty = sizeRiskoffEtfShares(28, DEFAULT_SLEEVE_EQUITY_USD, riskoffEtfSleeveFrac(2));
    expect(decided.buys[0].qty).toBe(gldQty);
    expect(decided.buys[1].qty).toBe(uupQty);
    expect(gldQty * 180 + uupQty * 28).toBeLessThanOrEqual(DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC);
    expect(decided.buys[0].thesis).toMatch(/top-2 GLD\+UUP 50\/50/);

    const book = paperBook();
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskoffEtfReturns: two,
      riskoffEtfAbove200: etfAbove200(),
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.bought.map((b) => b.symbol)).toEqual(["GLD", "UUP"]);
    expect(book.getPositions().map((p) => p.symbol).sort()).toEqual(["GLD", "UUP"]);
  });

  it("single qualifier → full overlay size; none → BIL", () => {
    expect(pickRiskoffEtfSleeve(gldWins, null, etfAbove200())).toEqual(["GLD"]);
    expect(pickRiskoffEtfSleeve(bothTrail, null, etfAbove200())).toEqual(["BIL"]);
    const one = decideRiskoffEtf({
      riskOn: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: gldWins,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(one.winners).toEqual(["GLD"]);
    expect(one.buy?.qty).toBe(sizeRiskoffEtfShares(180));
    expect((one.buy?.qty ?? 0) * 180).toBeLessThanOrEqual(DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_ETF_NOTIONAL_FRAC);
    const none = decideRiskoffEtf({
      riskOn: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: bothTrail,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(none.winners).toEqual(["BIL"]);
    expect(none.buy?.symbol).toBe("BIL");
    expect(none.buy?.qty).toBe(sizeRiskoffEtfShares(91));
  });

  it("CTA#1 + non-CTA#2 preferred over CTA#1+CTA#2 when both qualify", () => {
    const ctaLead = etfRs({ DBMF: 0.18, KMLM: 0.16, GLD: 0.1 });
    expect(isRiskoffEtfCta("DBMF")).toBe(true);
    expect(isRiskoffEtfCta("KMLM")).toBe(true);
    expect(isRiskoffEtfCta("GLD")).toBe(false);
    expect(pickRiskoffEtfWinner(ctaLead, null, etfAbove200())).toBe("DBMF");
    expect(pickRiskoffEtfSleeve(ctaLead, null, etfAbove200())).toEqual(["DBMF", "GLD"]);
    expect(
      pickRiskoffEtfSecond(["KMLM", "GLD"], "DBMF", ctaLead),
    ).toBe("GLD");
    const decided = decideRiskoffEtf({
      riskOn: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: ctaLead,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(decided.winners).toEqual(["DBMF", "GLD"]);
    expect(decided.winners).not.toContain("KMLM");
    expect(decided.buys.map((b) => b.symbol)).toEqual(["DBMF", "GLD"]);
  });

  it("CTA#1 + only other CTA → allow CTA pair", () => {
    const ctaOnly = etfRs({ DBMF: 0.18, KMLM: 0.14 });
    expect(pickRiskoffEtfSleeve(ctaOnly, null, etfAbove200())).toEqual(["DBMF", "KMLM"]);
    expect(pickRiskoffEtfSecond(["KMLM"], "DBMF", ctaOnly)).toBe("KMLM");
    const decided = decideRiskoffEtf({
      riskOn: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      returns: ctaOnly,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(decided.winners).toEqual(["DBMF", "KMLM"]);
    expect(decided.buys.map((b) => b.symbol)).toEqual(["DBMF", "KMLM"]);
    const kmlmFirst = etfRs({ KMLM: 0.2, DBMF: 0.15 });
    expect(pickRiskoffEtfSleeve(kmlmFirst, null, etfAbove200())).toEqual(["KMLM", "DBMF"]);
  });

  it("hysteresis still respected on #1 when a second qualifier is added", () => {
    const tiny = etfRs({ GLD: 0.1, UUP: 0.104 });
    expect(pickRiskoffEtfWinner(tiny, "GLD")).toBe("GLD");
    expect(pickRiskoffEtfSleeve(tiny, "GLD", etfAbove200())).toEqual(["GLD", "UUP"]);
    const hold = decideRiskoffEtf({
      riskOn: false,
      positions: [etfPos("GLD", 100, 180)],
      sleeve: defaultSleeves().riskoff,
      returns: tiny,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(hold.winner).toBe("GLD");
    expect(hold.winners).toEqual(["GLD", "UUP"]);
    expect(hold.sells).toEqual([]);
    expect(hold.buy?.symbol).toBe("UUP");
    const clear = etfRs({ GLD: 0.1, UUP: 0.106 });
    expect(pickRiskoffEtfWinner(clear, "GLD")).toBe("UUP");
    expect(pickRiskoffEtfSleeve(clear, "GLD", etfAbove200())).toEqual(["UUP", "GLD"]);
  });

  it("held CTA pair rotates #2 to a non-CTA when one qualifies", () => {
    const withGold = etfRs({ DBMF: 0.18, KMLM: 0.16, GLD: 0.09 });
    const decided = decideRiskoffEtf({
      riskOn: false,
      positions: [etfPos("DBMF", 200, 28), etfPos("KMLM", 200, 27)],
      sleeve: defaultSleeves().riskoff,
      returns: withGold,
      quotes: allEtfQuotes,
      above200: etfAbove200(),
    });
    expect(decided.winners).toEqual(["DBMF", "GLD"]);
    expect(decided.sells.map((s) => s.symbol)).toEqual(["KMLM"]);
    expect(decided.buy?.symbol).toBe("GLD");
  });
});

describe("flatten risk-off puts while SPY is above 200dma", () => {
  beforeEach(() => setPaperNow(new Date("2026-08-24T14:00:00Z")));
  afterEach(() => setPaperNow(null));

  it("decideRiskoffPutSells closes equity-index puts when spyAbove200, leaves ETF and HYG", () => {
    const spyPut = putVertPos("SPY");
    const hygPut = putVertPos("HYG");
    const gld = etfPos("GLD", 100, 180);
    expect(decideRiskoffPutSells([spyPut, hygPut, gld], false, { spyAbove200: true })).toEqual([
      { sleeveId: "riskoff", symbol: spyPut.symbol, reason: "SPY above 200dma: flatten risk-off puts" },
    ]);
    expect(decideRiskoffPutSells([spyPut, hygPut, gld], false, { spyAbove200: false })).toEqual([]);
    expect(decideRiskoffPutSells([spyPut, hygPut, gld], false)).toEqual([]);
  });

  it("flattens the HYG credit-leg put when HYG is back above 200, not the equity put or ETF", () => {
    const spyPut = putVertPos("SPY");
    const hygPut = putVertPos("HYG");
    const gld = etfPos("GLD", 100, 180);
    expect(
      decideRiskoffPutSells([spyPut, hygPut, gld], false, { spyAbove200: false, hygAbove200: true }),
    ).toEqual([
      {
        sleeveId: "riskoff",
        symbol: hygPut.symbol,
        reason: "HYG above 200dma: flatten credit-leg put",
      },
    ]);
  });

  it("flattens the HYG credit-leg put on RISK ON", () => {
    const hygPut = putVertPos("HYG");
    expect(decideRiskoffPutSells([hygPut], true, { hygAbove200: false })).toEqual([
      { sleeveId: "riskoff", symbol: hygPut.symbol, reason: "risk on: flatten credit-leg put" },
    ]);
  });

  it("flattens LQD/JNK credit-leg puts on own 200dma or RISK ON; missing check does not flatten", () => {
    const lqdPut = putVertPos("LQD");
    const jnkPut = putVertPos("JNK");
    const spyPut = putVertPos("SPY");
    expect(
      decideRiskoffPutSells([lqdPut, jnkPut, spyPut], false, {
        spyAbove200: false,
        lqdAbove200: true,
        jnkAbove200: false,
      }),
    ).toEqual([
      { sleeveId: "riskoff", symbol: lqdPut.symbol, reason: "LQD above 200dma: flatten credit-leg put" },
    ]);
    expect(decideRiskoffPutSells([lqdPut], true, { lqdAbove200: false })).toEqual([
      { sleeveId: "riskoff", symbol: lqdPut.symbol, reason: "risk on: flatten credit-leg put" },
    ]);
    expect(decideRiskoffPutSells([lqdPut, jnkPut], false, { spyAbove200: true })).toEqual([]);
  });

  it("HYG-only OFF flattens leftover SPY/QQQ puts, keeps the HYG put and ETF", async () => {
    const spyPut = putVertPos("SPY");
    const hygPut = putVertPos("HYG");
    const book = paperBook([etfPos("GLD", 100, 180), spyPut, hygPut]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: true, hygAbove200: false },
      riskoffQuotes: [
        { symbol: "SPY", last: 500 },
        { symbol: "QQQ", last: 400 },
        { symbol: "HYG", last: 77 },
      ],
      riskoffEtfReturns: gldWins,
      riskoffEtfAbove200: etfAbove200(),
      riskoffEtfQuotes: etfQuotes({ GLD: 180, UUP: 28, BIL: 91 }),
      place: book.place,
      close: book.close,
      placeVertical: async () => ({ ok: true }),
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async () => putChainForAuto,
      log: () => {},
    });
    expect(result.verticals).toEqual([]);
    expect(result.sold.map((s) => s.symbol)).toEqual([spyPut.symbol]);
    expect(result.bought).toEqual([]);
    const left = book.getPositions();
    expect(left.map((p) => p.symbol).sort()).toEqual([hygPut.symbol, "GLD"].sort());
    expect(left.some((p) => p.symbol === "GLD" && !p.vertical)).toBe(true);
    expect(left.some((p) => p.vertical?.quoteSymbol === "HYG")).toBe(true);
  });
});
