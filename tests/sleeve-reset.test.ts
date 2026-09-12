import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedEvents } from "../shared/clock";
import { DEFAULT_SLEEVE_EQUITY_USD } from "../shared/constants";
import type { StatusSnapshot } from "../shared/types";
import { emptyPaperStats } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import {
  alignedZeroSessionMark,
  nySessionDate,
  parsePaperReset,
  realizedDayPnlToMatchSessionDaily,
} from "../server/src/paper";
import { resetQuoteCache } from "../server/src/quotes";
import { resetMassiveCache } from "../server/src/massive";
import { resetRiskCache } from "../server/src/risk";
import { setMassiveTestKey, clearMassiveTestKey } from "./helpers/massiveStub";
import { StatusHub } from "../server/src/wsHub";

const realFetch = globalThis.fetch;

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

function makeTestApp() {
  const broker = new MockBroker();
  const engine = new GateEngine(broker, () => new Date(), () => seedEvents(), {
    enabled: true,
    dailyLossUsd: 500,
  });
  const app = buildApp({
    cfg: testCfg(),
    pool: null,
    redis: null,
    redisPub: null,
    broker,
    engine,
    getEvents: () => seedEvents(),
    setEvents: () => {},
    hub: new StatusHub(),
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

/** Massive/Yahoo quotes with no last — premarket / cash has not printed. */
function stubNoDelayedLast() {
  setMassiveTestKey();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("127.0.0.1") || url.includes("localhost")) {
        return realFetch(input as RequestInfo, init);
      }
      if (url.includes("/v2/snapshot/locale/us/markets/stocks/tickers/")) {
        const symbol = decodeURIComponent(url.split("/tickers/")[1]?.split("?")[0] ?? "X").toUpperCase();
        const body = {
          status: "OK",
          ticker: { ticker: symbol, lastTrade: null, prevDay: {}, day: {} },
        };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
      if (url.includes("/v8/finance/chart/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ chart: { result: [{ meta: { regularMarketPrice: null } }], error: null } }),
          text: async () => "{}",
        };
      }
      if (url.includes("/v2/aggs/ticker/")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ticker: "X", resultsCount: 0, results: [], status: "OK" }),
          text: async () => "{}",
        };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    }),
  );
}

describe("parsePaperReset", () => {
  it("requires a known sleeveId", () => {
    expect(parsePaperReset({})).toEqual({
      error: "sleeveId must be day|momentum|options|ownership|riskoff",
    });
    expect(parsePaperReset({ sleeveId: "live" })).toEqual({
      error: "sleeveId must be day|momentum|options|ownership|riskoff",
    });
    expect(parsePaperReset({ sleeveId: "riskoff" })).toEqual({ sleeveId: "riskoff" });
  });
});

describe("alignedZeroSessionMark", () => {
  it("zeros realized and unrealized for the NY session date", () => {
    const d = nySessionDate();
    expect(alignedZeroSessionMark(d)).toEqual({
      sessionDate: d,
      realizedPnlUsd: 0,
      unrealizedPnlUsd: 0,
    });
  });
});

describe("realizedDayPnlToMatchSessionDaily", () => {
  it("is 0 when leftover books are flat so stale dayPnl cannot trip GATE", () => {
    const books = {
      day: { dailyPnlUsd: 0, totalPnlUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlUsd: 0, equityUsd: 100_000 },
      momentum: { dailyPnlUsd: 0, totalPnlUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlUsd: 0, equityUsd: 100_000 },
      options: { dailyPnlUsd: 0, totalPnlUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlUsd: 0, equityUsd: 100_000 },
      ownership: { dailyPnlUsd: 0, totalPnlUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlUsd: 0, equityUsd: 100_000 },
      riskoff: { dailyPnlUsd: 0, totalPnlUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlUsd: 0, equityUsd: 100_000 },
    };
    expect(realizedDayPnlToMatchSessionDaily(books, [])).toBe(0);
  });

  it("keeps another sleeve's session daily (does not wipe account dayPnl on one-sleeve reset)", () => {
    const books = {
      day: { dailyPnlUsd: 0, totalPnlUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlUsd: 0, equityUsd: 100_000 },
      momentum: { dailyPnlUsd: -200, totalPnlUsd: -200, realizedPnlUsd: -160, unrealizedPnlUsd: -40, pnlUsd: -200, equityUsd: 99_800 },
      options: { dailyPnlUsd: 0, totalPnlUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlUsd: 0, equityUsd: 100_000 },
      ownership: { dailyPnlUsd: 0, totalPnlUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlUsd: 0, equityUsd: 100_000 },
      riskoff: { dailyPnlUsd: 0, totalPnlUsd: 0, realizedPnlUsd: 0, unrealizedPnlUsd: 0, pnlUsd: 0, equityUsd: 100_000 },
    };
    const positions = [
      {
        id: "p1",
        symbol: "SPY",
        root: null,
        qty: 8,
        side: "Long" as const,
        avgPrice: 510,
        unrealizedPnl: -40,
        gated: false,
        sleeveId: "momentum" as const,
      },
    ];
    expect(realizedDayPnlToMatchSessionDaily(books, positions)).toBe(-160);
  });
});

describe("MockBroker.resetSleeve", () => {
  it("drops one sleeve's lot and stop and leaves another sleeve alone", () => {
    const broker = new MockBroker();
    broker.injectPosition({
      symbol: "XLP",
      qty: 400,
      side: "Long",
      avgPrice: 80,
      unrealizedPnl: -20,
      sleeveId: "riskoff",
    });
    broker.injectOrder({
      symbol: "XLP",
      type: "StopMarket",
      side: "Sell",
      qty: 400,
      stopPrice: 73.6,
      sleeveId: "riskoff",
    });
    broker.injectPosition({
      symbol: "SPY",
      qty: 10,
      side: "Long",
      avgPrice: 500,
      unrealizedPnl: 15,
      sleeveId: "momentum",
    });
    broker.injectOrder({
      symbol: "SPY",
      type: "StopMarket",
      side: "Sell",
      qty: 10,
      stopPrice: 492.5,
      sleeveId: "momentum",
    });
    const out = broker.resetSleeve("riskoff");
    expect(out.removed).toHaveLength(1);
    expect(out.removed[0]?.symbol).toBe("XLP");
    expect(out.cancelled).toHaveLength(1);
    expect(out.cancelled[0]?.symbol).toBe("XLP");
    expect(broker.getPositionsSync().filter((p) => p.side !== "Flat")).toEqual([
      expect.objectContaining({ symbol: "SPY", sleeveId: "momentum", qty: 10, side: "Long" }),
    ]);
    const live = broker.getOrdersSync().filter((o) => o.state === "Working");
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ symbol: "SPY", sleeveId: "momentum" });
  });
});

describe("POST /api/paper/reset", () => {
  let savedPassword: string | undefined;

  beforeEach(() => {
    savedPassword = process.env.GATE_PASSWORD;
    delete process.env.GATE_PASSWORD;
    resetQuoteCache();
    resetMassiveCache();
    resetRiskCache();
    stubNoDelayedLast();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearMassiveTestKey();
    if (savedPassword === undefined) delete process.env.GATE_PASSWORD;
    else process.env.GATE_PASSWORD = savedPassword;
  });

  it("resets one sleeve with no delayed last and does not touch another sleeve", async () => {
    const { app, broker, engine } = makeTestApp();
    broker.addRealizedPnl(-80);
    broker.injectPosition({
      symbol: "XLP",
      qty: 500,
      side: "Long",
      avgPrice: 81,
      unrealizedPnl: -120,
      sleeveId: "riskoff",
    });
    broker.injectOrder({
      symbol: "XLP",
      type: "StopMarket",
      side: "Sell",
      qty: 500,
      stopPrice: 74.52,
      sleeveId: "riskoff",
    });
    broker.injectPosition({
      symbol: "SPY",
      qty: 8,
      side: "Long",
      avgPrice: 510,
      unrealizedPnl: 40,
      sleeveId: "momentum",
    });
    broker.injectOrder({
      symbol: "SPY",
      type: "StopMarket",
      side: "Sell",
      qty: 8,
      stopPrice: 501.35,
      sleeveId: "momentum",
    });
    const srv = await listen(app);
    try {
      const riskoffPaper = await fetch(`${srv.url}/api/sleeves/riskoff/paper`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trades: 3,
          wins: 1,
          losses: 2,
          realizedPnlUsd: -80,
          notes: "stuck overlay",
        }),
      });
      expect(riskoffPaper.status).toBe(200);

      const riskoffFill = await fetch(`${srv.url}/api/sleeves/riskoff/fills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: "XLP",
          side: "Buy",
          qty: 500,
          price: 81,
          notes: "overlay",
        }),
      });
      expect(riskoffFill.status).toBe(200);

      const momFill = await fetch(`${srv.url}/api/sleeves/momentum/fills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: "SPY",
          side: "Buy",
          qty: 8,
          price: 510,
          notes: "momentum long",
        }),
      });
      expect(momFill.status).toBe(200);

      const momPaper = await fetch(`${srv.url}/api/sleeves/momentum/paper`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trades: 2, wins: 2, losses: 0, realizedPnlUsd: 55, notes: "keep" }),
      });
      expect(momPaper.status).toBe(200);

      const close = await fetch(`${srv.url}/api/paper/close`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleeveId: "riskoff", symbol: "XLP", reason: "premarket reset" }),
      });
      expect(close.status).toBe(400);
      const closeBody = (await close.json()) as { error: string };
      expect(closeBody.error).toBe("no delayed last");

      expect(engine.enabled).toBe(true);
      const reset = await fetch(`${srv.url}/api/paper/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleeveId: "riskoff" }),
      });
      expect(reset.status).toBe(200);
      const snap = (await reset.json()) as StatusSnapshot;
      expect(snap.gateEnabled).toBe(true);
      expect(engine.enabled).toBe(true);
      expect(snap.autoPaper).toBe(true);
      expect(snap.autoPaperBySleeve.riskoff).toBe(true);
      expect(snap.autoPaperBySleeve.momentum).toBe(true);

      expect(snap.sleeves.riskoff.paper).toEqual(emptyPaperStats());
      expect(snap.paperBlotter.filter((f) => f.sleeveId === "riskoff")).toHaveLength(0);
      const riskoffBook = snap.sleeveBooks.riskoff;
      expect(riskoffBook.equityUsd).toBe(DEFAULT_SLEEVE_EQUITY_USD);
      expect(riskoffBook.realizedPnlUsd).toBe(0);
      expect(riskoffBook.unrealizedPnlUsd).toBe(0);
      expect(riskoffBook.totalPnlUsd).toBe(0);
      expect(riskoffBook.dailyPnlUsd).toBe(0);

      const open = snap.broker.positions.filter((p) => p.side !== "Flat" && p.qty > 0);
      expect(open.map((p) => p.symbol).sort()).toEqual(["SPY"]);
      expect(open[0]).toMatchObject({ sleeveId: "momentum", qty: 8, side: "Long" });
      const working = snap.broker.orders.filter((o) =>
        ["Working", "Submitted", "Accepted"].includes(o.state),
      );
      expect(working).toHaveLength(1);
      expect(working[0]).toMatchObject({ symbol: "SPY", sleeveId: "momentum" });

      expect(snap.sleeves.momentum.paper).toMatchObject({
        trades: 2,
        wins: 2,
        losses: 0,
        realizedPnlUsd: 55,
        notes: "keep",
      });
      expect(snap.paperBlotter.filter((f) => f.sleeveId === "momentum")).toHaveLength(1);
      expect(snap.sleeveBooks.momentum.realizedPnlUsd).toBe(55);
      expect(snap.sleeveBooks.momentum.unrealizedPnlUsd).toBe(40);
      expect(snap.sleeveBooks.momentum.equityUsd).toBe(DEFAULT_SLEEVE_EQUITY_USD + 55 + 40);
      expect(broker.getDayPnl()).toBeCloseTo(snap.sleeveBooks.momentum.dailyPnlUsd, 5);
    } finally {
      await srv.close();
      broker.reset();
    }
  });

  it("zeros stale mock dayPnl when leftover sleeve books are flat", async () => {
    const { app, broker } = makeTestApp();
    broker.setDayPnl(-645);
    const srv = await listen(app);
    try {
      const reset = await fetch(`${srv.url}/api/paper/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleeveId: "day" }),
      });
      expect(reset.status).toBe(200);
      const snap = (await reset.json()) as StatusSnapshot;
      expect(snap.sleeveBooks.day.dailyPnlUsd).toBe(0);
      expect(snap.sleeveBooks.day.totalPnlUsd).toBe(0);
      expect(broker.getDayPnl()).toBe(0);
      expect(snap.broker.dayPnl).toBe(0);
    } finally {
      await srv.close();
      broker.reset();
    }
  });

  it("refuses when the broker is not MockBroker", async () => {
    const { app, broker } = makeTestApp();
    (broker as { mode: "mock" | "demo" }).mode = "demo";
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleeveId: "riskoff" }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/MockBroker only/);
      expect(broker.getPositionsSync()).toHaveLength(0);
    } finally {
      await srv.close();
    }
  });

  it("400s an unknown sleeveId", async () => {
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/reset`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleeveId: "live" }),
      });
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});
