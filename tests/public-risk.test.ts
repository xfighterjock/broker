import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedEvents } from "../shared/clock";
import type { CalendarEvent } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { resetQuoteCache } from "../server/src/quotes";
import { resetMassiveCache } from "../server/src/massive";
import { resetRiskCache } from "../server/src/risk";
import { clearMassiveTestKey, setMassiveTestKey, stubMarketFetch } from "./helpers/massiveStub";
import { StatusHub } from "../server/src/wsHub";

// Known-good shape: exactly these top-level keys, exactly these riskChecks keys.
const ALLOWED_TOP_KEYS = ["riskOn", "riskChecks", "asOf"].sort();
const ALLOWED_CHECK_KEYS = [
  "spyAbove200",
  "acwiAbove200",
  "hygAbove200",
  "uup20dPct",
  "dollarVeto",
].sort();

// Fields that only ever appear on the full (authenticated) /api/status snapshot.
// None of these must ever leak onto the public endpoint.
const SENSITIVE_MARKERS = [
  "orders",
  "positions",
  "dayPnl",
  "sleeves",
  "sleeveBooks",
  "paperBlotter",
  "blotter",
  "checklist",
  "freeze",
  "knowledgeTime",
  "sessionLog",
  "actionLog",
  "gateEnabled",
  "dailyLossUsd",
  "qtyCap",
  "gatedRoots",
  "authRequired",
  "etradeAuth",
  "activeSleeve",
  "autoPaper",
  "autoPaperBySleeve",
  "SIMULATION",
];

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
  return { app };
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

describe("GET /api/public/risk", () => {
  beforeEach(() => {
    delete process.env.GATE_PASSWORD;
    delete process.env.AUTH_MODE;
    setMassiveTestKey();
    resetQuoteCache();
    resetMassiveCache();
    resetRiskCache();
  });

  afterEach(() => {
    delete process.env.GATE_PASSWORD;
    delete process.env.AUTH_MODE;
    clearMassiveTestKey();
    vi.unstubAllGlobals();
    resetMassiveCache();
    resetRiskCache();
  });

  it("returns exactly {riskOn, riskChecks, asOf} with the five known risk checks and nothing else", async () => {
    const { app } = makeTestApp();
    stubMarketFetch();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/public/risk`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        riskOn: boolean;
        riskChecks: Record<string, unknown>;
        asOf: string | null;
      };

      expect(Object.keys(body).sort()).toEqual(ALLOWED_TOP_KEYS);
      expect(Object.keys(body.riskChecks).sort()).toEqual(ALLOWED_CHECK_KEYS);
      expect(typeof body.riskOn).toBe("boolean");
      expect(typeof body.riskChecks.spyAbove200).toBe("boolean");
      expect(typeof body.riskChecks.acwiAbove200).toBe("boolean");
      expect(typeof body.riskChecks.hygAbove200).toBe("boolean");
      expect(typeof body.riskChecks.dollarVeto).toBe("boolean");
      expect(
        body.riskChecks.uup20dPct === null || typeof body.riskChecks.uup20dPct === "number",
      ).toBe(true);
      expect(typeof body.asOf).toBe("string");
      expect(Number.isNaN(Date.parse(body.asOf as string))).toBe(false);

      const raw = JSON.stringify(body);
      for (const marker of SENSITIVE_MARKERS) {
        expect(raw).not.toContain(marker);
      }
    } finally {
      await srv.close();
    }
  });

  it("sends no-store cache headers", async () => {
    const { app } = makeTestApp();
    stubMarketFetch();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/public/risk`);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
    } finally {
      await srv.close();
    }
  });

  it("is GET-only: POST is refused", async () => {
    const { app } = makeTestApp();
    stubMarketFetch();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/public/risk`, { method: "POST" });
      expect(res.status).not.toBe(200);
    } finally {
      await srv.close();
    }
  });

  it("works with no session cookie even when GATE_PASSWORD is set, while /api/status still 401s", async () => {
    process.env.GATE_PASSWORD = "test-only-not-real";
    const { app } = makeTestApp();
    stubMarketFetch();
    const srv = await listen(app);
    try {
      const publicRes = await fetch(`${srv.url}/api/public/risk`);
      expect(publicRes.status).toBe(200);
      const body = (await publicRes.json()) as { riskOn: boolean };
      expect(typeof body.riskOn).toBe("boolean");

      const statusRes = await fetch(`${srv.url}/api/status`);
      expect(statusRes.status).toBe(401);
    } finally {
      await srv.close();
      delete process.env.GATE_PASSWORD;
    }
  });
});
