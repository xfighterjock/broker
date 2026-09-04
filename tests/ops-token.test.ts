import http from "node:http";
import express from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedEvents } from "../shared/clock";
import { eventGateOpsToken, opsRouteAllowed } from "../server/src/auth";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { StatusHub } from "../server/src/wsHub";
import {
  MemoryUserDirectory,
  createUserWithPassword,
} from "../server/src/users";

const TEST_PASSWORD = "test-only-not-real-pass";
const OPS_TOKEN = "test-only-ops-token-not-a-secret";

function testCfg(over: Partial<AppConfig> = {}): AppConfig {
  return {
    databaseUrl: "postgres://x",
    redisUrl: "redis://127.0.0.1:6379",
    port: 0,
    bind: "127.0.0.1",
    gatePassword: undefined,
    tradingMode: "mock",
    nodeEnv: "test",
    cookieSecure: false,
    authMode: "users",
    tradovateBaseUrl: undefined,
    ...over,
  };
}

async function seededUsers(): Promise<MemoryUserDirectory> {
  const dir = new MemoryUserDirectory();
  const created = await createUserWithPassword(dir, "event-gate", TEST_PASSWORD);
  expect(created.ok).toBe(true);
  return dir;
}

function makeApp(dir: MemoryUserDirectory, cfg: AppConfig = testCfg()) {
  const broker = new MockBroker();
  const engine = new GateEngine(broker, () => new Date(), () => seedEvents(), {
    enabled: false,
    dailyLossUsd: 500,
  });
  const api = buildApp({
    cfg,
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
    users: dir,
  });
  const root = express();
  root.set("trust proxy", 1);
  root.use(
    session({
      name: "eg.sid",
      secret: "test-only-not-real",
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax",
        secure: false,
        path: "/",
      },
    }),
  );
  root.use(api);
  return { app: root, engine };
}

async function listen(app: express.Express) {
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

function opsHeaders(token = OPS_TOKEN): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

describe("EVENT_GATE_OPS_TOKEN helpers", () => {
  const saved = process.env.EVENT_GATE_OPS_TOKEN;

  afterEach(() => {
    if (saved === undefined) delete process.env.EVENT_GATE_OPS_TOKEN;
    else process.env.EVENT_GATE_OPS_TOKEN = saved;
  });

  it("treats missing and empty env as unset", () => {
    delete process.env.EVENT_GATE_OPS_TOKEN;
    expect(eventGateOpsToken()).toBeUndefined();
    process.env.EVENT_GATE_OPS_TOKEN = "";
    expect(eventGateOpsToken()).toBeUndefined();
  });

  it("allowlists freeze/status and denies trading mutations", () => {
    expect(opsRouteAllowed("GET", "/status")).toBe(true);
    expect(opsRouteAllowed("GET", "/freeze")).toBe(true);
    expect(opsRouteAllowed("PUT", "/freeze")).toBe(true);
    expect(opsRouteAllowed("GET", "/health")).toBe(true);
    expect(opsRouteAllowed("GET", "/sleeves")).toBe(true);
    expect(opsRouteAllowed("POST", "/flatten")).toBe(false);
    expect(opsRouteAllowed("POST", "/gate/enable")).toBe(false);
    expect(opsRouteAllowed("POST", "/paper/order")).toBe(false);
    expect(opsRouteAllowed("POST", "/paper/auto")).toBe(false);
    expect(opsRouteAllowed("POST", "/cancel-stops")).toBe(false);
    expect(opsRouteAllowed("POST", "/mock/inject-stop")).toBe(false);
    expect(opsRouteAllowed("POST", "/etrade/oauth/pin")).toBe(false);
    expect(opsRouteAllowed("PUT", "/sleeves/day")).toBe(false);
  });
});

describe("EVENT_GATE_OPS_TOKEN HTTPS ops scope", () => {
  const savedMode = process.env.AUTH_MODE;
  const savedPassword = process.env.GATE_PASSWORD;
  const savedOps = process.env.EVENT_GATE_OPS_TOKEN;

  beforeEach(() => {
    process.env.AUTH_MODE = "users";
    delete process.env.GATE_PASSWORD;
    process.env.EVENT_GATE_OPS_TOKEN = OPS_TOKEN;
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = savedMode;
    if (savedPassword === undefined) delete process.env.GATE_PASSWORD;
    else process.env.GATE_PASSWORD = savedPassword;
    if (savedOps === undefined) delete process.env.EVENT_GATE_OPS_TOKEN;
    else process.env.EVENT_GATE_OPS_TOKEN = savedOps;
  });

  it("lets the ops bearer GET status and PUT freeze", async () => {
    const dir = await seededUsers();
    const { app } = makeApp(dir);
    const srv = await listen(app);
    try {
      const status = await fetch(`${srv.url}/api/status`, { headers: opsHeaders() });
      expect(status.status).toBe(200);
      const snap = (await status.json()) as { gateEnabled?: boolean; freeze?: { consensusObjects?: string } };
      expect(typeof snap.gateEnabled).toBe("boolean");
      expect(JSON.stringify(snap)).not.toContain(OPS_TOKEN);

      const sleeves = await fetch(`${srv.url}/api/sleeves`, { headers: opsHeaders() });
      expect(sleeves.status).toBe(200);

      const freezeGet = await fetch(`${srv.url}/api/freeze`, { headers: opsHeaders() });
      expect(freezeGet.status).toBe(200);

      const freezePut = await fetch(`${srv.url}/api/freeze`, {
        method: "PUT",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          consensusObjects: "ops freeze save",
          sourceLabel: "test",
          fedWatchSnapshot: "n/a",
          liquidContracts: { MES: "MESU6", ZN: "ZNU6", M6E: "M6EU6", SR3: "SR3U6" },
        }),
      });
      expect(freezePut.status).toBe(200);
      const after = (await freezePut.json()) as { freeze?: { consensusObjects?: string } };
      expect(after.freeze?.consensusObjects).toBe("ops freeze save");
    } finally {
      await srv.close();
    }
  });

  it("rejects flatten, gate enable, and paper with the ops bearer", async () => {
    const dir = await seededUsers();
    const { app, engine } = makeApp(dir);
    const srv = await listen(app);
    try {
      const flatten = await fetch(`${srv.url}/api/flatten`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      expect(flatten.status).toBe(401);

      const gate = await fetch(`${srv.url}/api/gate/enable`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      });
      expect(gate.status).toBe(401);
      expect(engine.enabled).toBe(false);

      const paper = await fetch(`${srv.url}/api/paper/order`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          sleeveId: "momentum",
          symbol: "SPY",
          side: "Buy",
          qty: 1,
          stopPrice: 90,
          thesis: "ops must not trade",
        }),
      });
      expect(paper.status).toBe(401);

      const auto = await fetch(`${srv.url}/api/paper/auto`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(auto.status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it("401s protected routes when the ops token is missing or wrong", async () => {
    const dir = await seededUsers();
    const { app } = makeApp(dir);
    const srv = await listen(app);
    try {
      const missing = await fetch(`${srv.url}/api/status`);
      expect(missing.status).toBe(401);

      const wrong = await fetch(`${srv.url}/api/status`, {
        headers: opsHeaders("wrong-ops-token-not-a-secret"),
      });
      expect(wrong.status).toBe(401);

      const freezeWrong = await fetch(`${srv.url}/api/freeze`, {
        method: "PUT",
        headers: {
          ...opsHeaders("wrong-ops-token-not-a-secret"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ consensusObjects: "nope" }),
      });
      expect(freezeWrong.status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it("leaves user bearer full access when the ops token is also set", async () => {
    const dir = await seededUsers();
    const { app, engine } = makeApp(dir);
    const srv = await listen(app);
    try {
      const login = await fetch(`${srv.url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "event-gate", password: TEST_PASSWORD }),
      });
      const body = (await login.json()) as { token: string };
      const gate = await fetch(`${srv.url}/api/gate/enable`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${body.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      });
      expect(gate.status).toBe(200);
      expect(engine.enabled).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("does not treat a bearer as ops when EVENT_GATE_OPS_TOKEN is unset", async () => {
    delete process.env.EVENT_GATE_OPS_TOKEN;
    const dir = await seededUsers();
    const { app } = makeApp(dir);
    const srv = await listen(app);
    try {
      const status = await fetch(`${srv.url}/api/status`, { headers: opsHeaders() });
      expect(status.status).toBe(401);
    } finally {
      await srv.close();
    }
  });
});
