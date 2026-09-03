import http from "node:http";
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
import { setMassiveTestKey, clearMassiveTestKey, stubMarketFetch } from "./helpers/massiveStub";
import { StatusHub } from "../server/src/wsHub";
import { resetEtradeCache } from "../server/src/etrade";
import { setPaperNow } from "../server/src/vertical";

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
}

/**
 * Minimal E*TRADE-shaped /v1/market/optionchains body: one put pair at the
 * given strike with the given bid/ask/openInterest. SelectedED pins the
 * expiry so legs resolve without relying on osiKey parsing.
 */
function putPair(strike: number, bid: number, ask: number) {
  return {
    Put: {
      strikePrice: strike,
      optionRootSymbol: "HYG",
      optionType: "PUT",
      bid,
      ask,
      lastPrice: (bid + ask) / 2,
      bidSize: 500,
      askSize: 500,
      openInterest: 500,
    },
  };
}

function hygChainJson(long: { bid: number; ask: number }, short: { bid: number; ask: number }) {
  return {
    OptionChainResponse: {
      SelectedED: { year: 2026, month: 10, day: 9 },
      OptionPair: [putPair(79, long.bid, long.ask), putPair(78.5, short.bid, short.ask)],
    },
  };
}

/**
 * Installs the standard Massive/E*TRADE/Yahoo stub, then layers a mutable
 * HYG option-chain response on top so the SAME 79/78.5P chain can move
 * between the entry quote and a later, worse quote (the actual incident:
 * entry long ask .42 / short bid .22 = .20 debit; later long bid .36 /
 * short ask .29 = .07 close, a 50% debit stop).
 */
function stubMovingHygChain() {
  stubMarketFetch();
  const inner = globalThis.fetch as unknown as (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<unknown>;
  let phase: "open" | "closed" = "open";
  const openBody = hygChainJson({ bid: 0.4, ask: 0.42 }, { bid: 0.22, ask: 0.24 });
  const closedBody = hygChainJson({ bid: 0.36, ask: 0.38 }, { bid: 0.27, ask: 0.29 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/market/optionchains")) {
        const body = phase === "open" ? openBody : closedBody;
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      return inner(input, init);
    }),
  );
  return {
    setClosed: () => {
      phase = "closed";
    },
  };
}

describe("vertical exit blotter price: immediate close credit, not close + entry debit", () => {
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
    // 2026-09-03 08:50 CT / 09:50 ET — the actual incident's open time, weekday, before the 15:50 ET cutoff.
    setPaperNow(new Date("2026-09-03T13:50:00.000Z"));
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

  it("records .07 (hit.closeValue / (qty*100)) at the 50% debit stop, never .27 (close + entry debit)", async () => {
    const { app } = makeTestApp();
    const stub = stubMovingHygChain();
    const srv = await listen(app);
    try {
      const openRes = await fetch(`${srv.url}/api/paper/vertical`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sleeveId: "riskoff",
          symbol: "HYG",
          right: "P",
          expiry: "2026-10-09",
          longStrike: 79,
          shortStrike: 78.5,
          qty: 5,
          thesis: "test HYG credit-leg put debit",
        }),
      });
      expect(openRes.status).toBe(200);
      const openSnap = (await openRes.json()) as StatusSnapshot;
      const openedPos = openSnap.broker.positions.find((p) => p.side !== "Flat" && p.vertical);
      expect(openedPos).toBeDefined();
      const symbol = openedPos!.symbol;
      // Entry natural debit: longAsk .42 - shortBid .22 = .20/share -> $100 for 5 contracts.
      const longFill = openSnap.paperBlotter.find((f) => f.notes.includes("vertical long"));
      const shortFill = openSnap.paperBlotter.find((f) => f.notes.includes("vertical short"));
      expect(longFill?.price).toBeCloseTo(0.42);
      expect(shortFill?.price).toBeCloseTo(0.22);

      // Move the chain to the incident's worse quote and force a fresh fetch.
      resetEtradeCache();
      stub.setClosed();
      const afterClose = await fetch(`${srv.url}/api/status`);
      expect(afterClose.status).toBe(200);
      const closedSnap = (await afterClose.json()) as StatusSnapshot;
      const exitFill = closedSnap.paperBlotter.find(
        (f) => f.symbol === symbol && f.notes.includes("vertical exit"),
      );
      expect(exitFill).toBeDefined();
      expect(exitFill?.notes).toMatch(/50% debit stop/);
      // hit.closeValue / (qty*100) = (longBid .36 - shortAsk .29) = .07 exactly.
      expect(exitFill?.price).toBeCloseTo(0.07, 5);
      // The bug this replaces would have recorded close + entry debit = .07 + .20 = .27.
      expect(exitFill?.price).not.toBeCloseTo(0.27, 2);
      // realizedPnl = close ($35) - netDebitPaid ($100) = -$65 for 5 contracts, booked into the sleeve.
      expect(closedSnap.sleeveBooks.riskoff.realizedPnlUsd).toBeCloseTo(-65, 0);
    } finally {
      await srv.close();
    }
  });
});
