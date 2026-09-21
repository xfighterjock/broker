import http from "node:http";
import express from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function makeApp(
  dir: MemoryUserDirectory,
  cfg: AppConfig = testCfg(),
  opts: { engineEnabled?: boolean } = {},
) {
  const broker = new MockBroker();
  const engine = new GateEngine(broker, () => new Date(), () => seedEvents(), {
    enabled: opts.engineEnabled ?? false,
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
  return { app: root, engine, broker };
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

  it("allowlists freeze/status/AUTO/flatten/sleeve-reset/GATE toggle and denies trading mutations", () => {
    expect(opsRouteAllowed("GET", "/status")).toBe(true);
    expect(opsRouteAllowed("GET", "/freeze")).toBe(true);
    expect(opsRouteAllowed("PUT", "/freeze")).toBe(true);
    expect(opsRouteAllowed("GET", "/health")).toBe(true);
    expect(opsRouteAllowed("GET", "/sleeves")).toBe(true);
    expect(opsRouteAllowed("POST", "/paper/auto")).toBe(true);
    expect(opsRouteAllowed("POST", "/flatten")).toBe(true);
    expect(opsRouteAllowed("POST", "/paper/reset")).toBe(true);
    expect(opsRouteAllowed("POST", "/gate/enable")).toBe(true);
    expect(opsRouteAllowed("POST", "/knowledge-time")).toBe(true);
    expect(opsRouteAllowed("POST", "/etrade/renew")).toBe(true);
    expect(opsRouteAllowed("POST", "/paper/order")).toBe(false);
    expect(opsRouteAllowed("GET", "/activity")).toBe(false);
    expect(opsRouteAllowed("GET", "/log")).toBe(false);
    expect(opsRouteAllowed("POST", "/cancel-stops")).toBe(false);
    expect(opsRouteAllowed("POST", "/mock/inject-stop")).toBe(false);
    expect(opsRouteAllowed("POST", "/etrade/oauth/start")).toBe(false);
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
    vi.unstubAllGlobals();
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

  it("lets the ops bearer POST /api/paper/auto for a sleeve", async () => {
    const dir = await seededUsers();
    const { app } = makeApp(dir);
    const srv = await listen(app);
    try {
      const off = await fetch(`${srv.url}/api/paper/auto`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(off.status).toBe(200);

      const auto = await fetch(`${srv.url}/api/paper/auto`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ sleeveId: "day", enabled: true }),
      });
      expect(auto.status).toBe(200);
      const snap = (await auto.json()) as {
        autoPaperBySleeve?: { day?: boolean };
      };
      expect(snap.autoPaperBySleeve?.day).toBe(true);
      expect(JSON.stringify(snap)).not.toContain(OPS_TOKEN);

      const status = await fetch(`${srv.url}/api/status`, { headers: opsHeaders() });
      expect(status.status).toBe(200);
      const after = (await status.json()) as {
        autoPaperBySleeve?: { day?: boolean };
      };
      expect(after.autoPaperBySleeve?.day).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("lets the ops bearer POST flatten on MockBroker", async () => {
    const dir = await seededUsers();
    const { app, broker } = makeApp(dir);
    broker.injectPosition({ symbol: "MESU6", qty: 1, side: "Long", avgPrice: 5800 });
    const srv = await listen(app);
    try {
      const flatten = await fetch(`${srv.url}/api/flatten`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      expect(flatten.status).toBe(200);
      const snap = (await flatten.json()) as {
        gateEnabled?: boolean;
        broker?: { positions?: { symbol: string; side: string; qty: number }[] };
      };
      expect(typeof snap.gateEnabled).toBe("boolean");
      expect(JSON.stringify(snap)).not.toContain(OPS_TOKEN);
      const mes = snap.broker?.positions?.find((p) => p.symbol === "MESU6");
      expect(mes?.side).toBe("Flat");
      expect(mes?.qty).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it("lets the ops bearer POST /api/paper/reset on MockBroker", async () => {
    const dir = await seededUsers();
    const { app, broker, engine } = makeApp(dir, testCfg(), { engineEnabled: true });
    broker.injectPosition({
      symbol: "XLP",
      qty: 500,
      side: "Long",
      avgPrice: 80,
      unrealizedPnl: -40,
      sleeveId: "riskoff",
    });
    broker.injectOrder({
      symbol: "XLP",
      type: "StopMarket",
      side: "Sell",
      qty: 500,
      stopPrice: 73.6,
      sleeveId: "riskoff",
    });
    expect(engine.enabled).toBe(true);
    const srv = await listen(app);
    try {
      const reset = await fetch(`${srv.url}/api/paper/reset`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ sleeveId: "riskoff" }),
      });
      expect(reset.status).toBe(200);
      const snap = (await reset.json()) as {
        gateEnabled?: boolean;
        autoPaperBySleeve?: { riskoff?: boolean };
        sleeveBooks?: { riskoff?: { equityUsd: number; realizedPnlUsd: number; unrealizedPnlUsd: number } };
        broker?: { positions?: { symbol: string; side: string; qty: number }[]; orders?: { symbol: string; state: string }[] };
      };
      expect(snap.gateEnabled).toBe(true);
      expect(engine.enabled).toBe(true);
      expect(snap.autoPaperBySleeve?.riskoff).toBe(true);
      expect(snap.sleeveBooks?.riskoff?.equityUsd).toBe(100_000);
      expect(snap.sleeveBooks?.riskoff?.realizedPnlUsd).toBe(0);
      expect(snap.sleeveBooks?.riskoff?.unrealizedPnlUsd).toBe(0);
      const xlp = snap.broker?.positions?.find((p) => p.symbol === "XLP");
      expect(xlp).toBeUndefined();
      const working = snap.broker?.orders?.filter((o) => o.symbol === "XLP" && o.state === "Working");
      expect(working ?? []).toHaveLength(0);
      expect(JSON.stringify(snap)).not.toContain(OPS_TOKEN);
    } finally {
      await srv.close();
    }
  });

  it("lets the ops bearer POST /api/etrade/renew and 401s PIN handshake routes", async () => {
    const realFetch = globalThis.fetch;
    const etradeKeys = [
      "ETRADE_ENV",
      "ETRADE_PROD_KEY",
      "ETRADE_PROD_SECRET",
      "ETRADE_PROD_ACCESS_TOKEN",
      "ETRADE_PROD_ACCESS_SECRET",
    ] as const;
    const savedEtrade: Record<string, string | undefined> = {};
    for (const k of etradeKeys) savedEtrade[k] = process.env[k];
    process.env.ETRADE_ENV = "production";
    process.env.ETRADE_PROD_KEY = "ck-test-ops-renew";
    process.env.ETRADE_PROD_SECRET = "cs-test-ops-renew";
    process.env.ETRADE_PROD_ACCESS_TOKEN = "at-test-ops-renew";
    process.env.ETRADE_PROD_ACCESS_SECRET = "as-test-ops-renew";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("127.0.0.1") || url.includes("localhost")) {
          return realFetch(input as RequestInfo, init);
        }
        expect(url).toBe("https://api.etrade.com/oauth/renew_access_token");
        expect(url).not.toContain("/v1/order");
        expect(url).not.toContain("/v1/accounts");
        return {
          ok: true,
          status: 200,
          text: async () => "Access Token has been renewed",
        };
      }),
    );
    const dir = await seededUsers();
    const { app } = makeApp(dir);
    const srv = await listen(app);
    try {
      const renew = await realFetch(`${srv.url}/api/etrade/renew`, {
        method: "POST",
        headers: opsHeaders(),
      });
      expect(renew.status).toBe(200);
      const body = (await renew.json()) as { ok?: boolean };
      expect(body).toEqual({ ok: true });
      expect(JSON.stringify(body)).not.toContain(OPS_TOKEN);

      const start = await realFetch(`${srv.url}/api/etrade/oauth/start`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      expect(start.status).toBe(401);

      const pin = await realFetch(`${srv.url}/api/etrade/oauth/pin`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ pin: "000000" }),
      });
      expect(pin.status).toBe(401);
      const pinBody = (await pin.json()) as { error?: string };
      expect(pinBody.error).toBe("ops token not permitted");
      expect(JSON.stringify(pinBody)).not.toContain("000000");
    } finally {
      await srv.close();
      vi.unstubAllGlobals();
      for (const k of etradeKeys) {
        if (savedEtrade[k] === undefined) delete process.env[k];
        else process.env[k] = savedEtrade[k];
      }
    }
  });

  it("lets the ops bearer POST /api/knowledge-time", async () => {
    const dir = await seededUsers();
    const { app } = makeApp(dir);
    const srv = await listen(app);
    try {
      const stamp = await fetch(`${srv.url}/api/knowledge-time`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      expect(stamp.status).toBe(200);
      const snap = (await stamp.json()) as {
        knowledgeTime?: string | null;
        checklist?: { knowledgeTimeAfterPrint?: boolean | null };
      };
      expect(typeof snap.knowledgeTime).toBe("string");
      expect(snap.knowledgeTime).toBeTruthy();
      expect(snap.checklist?.knowledgeTimeAfterPrint).toBe(true);
      expect(JSON.stringify(snap)).not.toContain(OPS_TOKEN);

      const again = await fetch(`${srv.url}/api/knowledge-time`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      expect(again.status).toBe(200);
      const second = (await again.json()) as { knowledgeTime?: string | null };
      expect(second.knowledgeTime).toBe(snap.knowledgeTime);
    } finally {
      await srv.close();
    }
  });

  it("lets the ops bearer GATE OFF via POST /api/gate/enable", async () => {
    const dir = await seededUsers();
    const { app, engine } = makeApp(dir, testCfg(), { engineEnabled: true });
    expect(engine.enabled).toBe(true);
    const srv = await listen(app);
    try {
      const gate = await fetch(`${srv.url}/api/gate/enable`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(gate.status).toBe(200);
      const snap = (await gate.json()) as { gateEnabled?: boolean };
      expect(snap.gateEnabled).toBe(false);
      expect(engine.enabled).toBe(false);
      expect(JSON.stringify(snap)).not.toContain(OPS_TOKEN);
    } finally {
      await srv.close();
    }
  });

  it("rejects paper orders with the ops bearer", async () => {
    const dir = await seededUsers();
    const { app } = makeApp(dir);
    const srv = await listen(app);
    try {
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

      const flattenMissing = await fetch(`${srv.url}/api/flatten`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(flattenMissing.status).toBe(401);

      const flattenWrong = await fetch(`${srv.url}/api/flatten`, {
        method: "POST",
        headers: {
          ...opsHeaders("wrong-ops-token-not-a-secret"),
          "Content-Type": "application/json",
        },
        body: "{}",
      });
      expect(flattenWrong.status).toBe(401);

      const gateWrong = await fetch(`${srv.url}/api/gate/enable`, {
        method: "POST",
        headers: {
          ...opsHeaders("wrong-ops-token-not-a-secret"),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: false }),
      });
      expect(gateWrong.status).toBe(401);
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
