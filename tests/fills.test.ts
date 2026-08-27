import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedEvents } from "../shared/clock";
import type { StatusSnapshot } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { StatusHub } from "../server/src/wsHub";

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
  const events = seedEvents();
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
  return { app, broker };
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

describe("POST /api/sleeves/:id/fills paper journal", () => {
  let savedPassword: string | undefined;

  beforeEach(() => {
    savedPassword = process.env.GATE_PASSWORD;
    delete process.env.GATE_PASSWORD;
  });

  afterEach(() => {
    if (savedPassword === undefined) delete process.env.GATE_PASSWORD;
    else process.env.GATE_PASSWORD = savedPassword;
  });

  it("appends a fill, bumps trades, and never calls broker methods", async () => {
    const { app, broker } = makeTestApp();
    const injectOrder = vi.spyOn(broker, "injectOrder");
    const injectPosition = vi.spyOn(broker, "injectPosition");
    const flattenSymbols = vi.spyOn(broker, "flattenSymbols");
    const cancelOrders = vi.spyOn(broker, "cancelOrders");
    const setDayPnl = vi.spyOn(broker, "setDayPnl");
    const beforeOrders = broker.getOrdersSync();
    const beforePositions = broker.getPositionsSync();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/sleeves/momentum/fills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: "SPY",
          side: "Buy",
          qty: 2,
          price: 500.25,
          notes: "journal only",
        }),
      });
      expect(res.status).toBe(200);
      const snap = (await res.json()) as StatusSnapshot;
      expect(snap.sleeves.momentum.paper.trades).toBe(1);
      expect(snap.paperBlotter).toHaveLength(1);
      expect(snap.paperBlotter[0]).toMatchObject({
        sleeveId: "momentum",
        symbol: "SPY",
        side: "Buy",
        qty: 2,
        price: 500.25,
        notes: "journal only",
      });
      expect(injectOrder).not.toHaveBeenCalled();
      expect(injectPosition).not.toHaveBeenCalled();
      expect(flattenSymbols).not.toHaveBeenCalled();
      expect(cancelOrders).not.toHaveBeenCalled();
      expect(setDayPnl).not.toHaveBeenCalled();
      expect(broker.getOrdersSync()).toEqual(beforeOrders);
      expect(broker.getPositionsSync()).toEqual(beforePositions);
    } finally {
      await srv.close();
    }
  });

  it("does not call the broker on a bad fill body", async () => {
    const { app, broker } = makeTestApp();
    const injectOrder = vi.spyOn(broker, "injectOrder");
    const flattenSymbols = vi.spyOn(broker, "flattenSymbols");
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/sleeves/day/fills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ side: "Buy", qty: 1, price: 1 }),
      });
      expect(res.status).toBe(400);
      expect(injectOrder).not.toHaveBeenCalled();
      expect(flattenSymbols).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  });
});
