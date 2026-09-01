import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seedEvents, zonedTimeToUtc } from "../shared/clock";
import { TZ } from "../shared/constants";
import type { CalendarEvent } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import {
  ETRADE_ACCESS_TOKEN_RENEW_MS,
  etradeKeepAliveEnabled,
  isEtradeCashSession,
  renewAccessToken,
  startEtradeAccessTokenKeepAlive,
  stopEtradeAccessTokenKeepAlive,
} from "../server/src/etrade";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { StatusHub } from "../server/src/wsHub";

const CONSUMER_KEY = "ck-prod-TESTKEY";
const CONSUMER_SECRET = "cs-prod-TESTSECRET";
const ACCESS_TOKEN = "at-prod-TESTTOKEN";
const ACCESS_SECRET = "as-prod-TESTSECRET";
const NEW_TOKEN = "at-prod-NEWTOKEN";
const NEW_SECRET = "as-prod-NEWSECRET";
const LEAKED = "leaked-oauth-token-SHOULD-NOT-PRINT";

const SECRET_VALUES = [
  CONSUMER_KEY,
  CONSUMER_SECRET,
  ACCESS_TOKEN,
  ACCESS_SECRET,
  NEW_TOKEN,
  NEW_SECRET,
  LEAKED,
];

function mockResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function prodEnv(extras: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    ETRADE_ENV: "production",
    ETRADE_PROD_KEY: CONSUMER_KEY,
    ETRADE_PROD_SECRET: CONSUMER_SECRET,
    ETRADE_PROD_ACCESS_TOKEN: ACCESS_TOKEN,
    ETRADE_PROD_ACCESS_SECRET: ACCESS_SECRET,
    ...extras,
  };
}

function writeEnv(dir: string, extras: Record<string, string> = {}) {
  const file = path.join(dir, ".env.etrade");
  const rows: Record<string, string> = {
    ETRADE_ENV: "production",
    ETRADE_PROD_KEY: CONSUMER_KEY,
    ETRADE_PROD_SECRET: CONSUMER_SECRET,
    ETRADE_PROD_ACCESS_TOKEN: ACCESS_TOKEN,
    ETRADE_PROD_ACCESS_SECRET: ACCESS_SECRET,
    ...extras,
  };
  const text = Object.entries(rows)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(file, `${text}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

function expectNoSecrets(output: string) {
  for (const secret of SECRET_VALUES) {
    expect(output).not.toContain(secret);
  }
  expect(output).not.toMatch(/us\.etrade\.com\/e\/t\/etws\/authorize\?key=/);
}

describe("renewAccessToken in-process keep-alive", () => {
  const dirs: string[] = [];

  afterEach(() => {
    stopEtradeAccessTokenKeepAlive();
    vi.useRealTimers();
    while (dirs.length) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir() {
    const dir = mkdtempSync(path.join(tmpdir(), "etrade-renew-"));
    dirs.push(dir);
    return dir;
  }

  it("upserts new token fields, updates process.env, chmod 600, and prints no secrets", async () => {
    const envFile = writeEnv(tmpDir());
    const env = prodEnv();
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.etrade.com/oauth/renew_access_token");
      return mockResponse(200, `oauth_token=${NEW_TOKEN}&oauth_token_secret=${NEW_SECRET}`);
    });
    const got = await renewAccessToken({
      env,
      envFile,
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    expect(got).toEqual({ ok: true, rotated: true });
    expect(logs.join("\n")).toMatch(/\[EventGate\] etrade access token renewed/);
    expectNoSecrets(logs.join("\n"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0][1] as {
      method?: string;
      headers?: { Authorization?: string };
    };
    expect(init.method).toBe("GET");
    expect(init.headers?.Authorization).toMatch(/^OAuth /);
    expect(init.headers?.Authorization).toContain(`oauth_token="${ACCESS_TOKEN}"`);
    expect(env.ETRADE_PROD_ACCESS_TOKEN).toBe(NEW_TOKEN);
    expect(env.ETRADE_PROD_ACCESS_SECRET).toBe(NEW_SECRET);
    const written = readFileSync(envFile, "utf8");
    expect(written).toContain(`ETRADE_PROD_ACCESS_TOKEN=${NEW_TOKEN}`);
    expect(written).toContain(`ETRADE_PROD_ACCESS_SECRET=${NEW_SECRET}`);
    expect(written).not.toContain(`ETRADE_PROD_ACCESS_TOKEN=${ACCESS_TOKEN}`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("keeps the existing token when the body is Access Token has been renewed", async () => {
    const envFile = writeEnv(tmpDir());
    const env = prodEnv();
    const before = readFileSync(envFile, "utf8");
    const logs: string[] = [];
    const fetchImpl = vi.fn(async () => mockResponse(200, "Access Token has been renewed"));
    const got = await renewAccessToken({
      env,
      envFile,
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    expect(got).toEqual({ ok: true, rotated: false });
    expect(logs.join("\n")).toMatch(/\[EventGate\] etrade access token renewed/);
    expectNoSecrets(logs.join("\n"));
    expect(env.ETRADE_PROD_ACCESS_TOKEN).toBe(ACCESS_TOKEN);
    expect(readFileSync(envFile, "utf8")).toBe(before);
  });

  it("keeps the existing token on HTTP success with an empty body", async () => {
    const envFile = writeEnv(tmpDir());
    const env = prodEnv();
    const before = readFileSync(envFile, "utf8");
    const logs: string[] = [];
    const fetchImpl = vi.fn(async () => mockResponse(200, ""));
    const got = await renewAccessToken({
      env,
      envFile,
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    expect(got.ok).toBe(true);
    expectNoSecrets(logs.join("\n"));
    expect(env.ETRADE_PROD_ACCESS_TOKEN).toBe(ACCESS_TOKEN);
    expect(readFileSync(envFile, "utf8")).toBe(before);
  });

  it("returns a structured error on 401, process stays up, no secrets in logs", async () => {
    const envFile = writeEnv(tmpDir());
    const env = prodEnv();
    const logs: string[] = [];
    const fetchImpl = vi.fn(async () =>
      mockResponse(401, `oauth_token=${LEAKED}&oauth_token_secret=${LEAKED}`),
    );
    const got = await renewAccessToken({
      env,
      envFile,
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    expect(got.ok).toBe(false);
    if (got.ok) throw new Error("expected failure");
    expect(got.error).toMatch(/HTTP 401/);
    expect(got.status).toBe(401);
    expect(logs.join("\n")).toMatch(/\[EventGate\] etrade renew failed: HTTP 401/);
    expectNoSecrets(logs.join("\n"));
    expect(env.ETRADE_PROD_ACCESS_TOKEN).toBe(ACCESS_TOKEN);
    expect(readFileSync(envFile, "utf8")).toContain(`ETRADE_PROD_ACCESS_TOKEN=${ACCESS_TOKEN}`);
  });

  it("does not call the network when the access token is missing", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("network should not be called");
    });
    const got = await renewAccessToken({
      env: prodEnv({ ETRADE_PROD_ACCESS_TOKEN: "", ETRADE_PROD_ACCESS_SECRET: "" }),
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    expect(got.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    if (got.ok) throw new Error("expected failure");
    expect(got.error).toMatch(/missing access token/);
    expect(got.silent).toBe(true);
    expectNoSecrets(logs.join("\n"));
  });

  it("timer does not start in test env", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => ({ ok: true as const, rotated: false }));
    expect(etradeKeepAliveEnabled({ NODE_ENV: "test" })).toBe(false);
    expect(etradeKeepAliveEnabled()).toBe(false);
    startEtradeAccessTokenKeepAlive({
      env: { NODE_ENV: "test" },
      now: () => zonedTimeToUtc(2026, 8, 31, 10, 0, 0, TZ),
      renew,
    });
    await vi.advanceTimersByTimeAsync(ETRADE_ACCESS_TOKEN_RENEW_MS * 3);
    expect(renew).not.toHaveBeenCalled();
  });

  it("timer ticks during the cash session in production env", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => ({ ok: true as const, rotated: false }));
    expect(etradeKeepAliveEnabled({ NODE_ENV: "production" })).toBe(true);
    startEtradeAccessTokenKeepAlive({
      env: { NODE_ENV: "production" },
      now: () => zonedTimeToUtc(2026, 8, 31, 10, 0, 0, TZ),
      renew,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(ETRADE_ACCESS_TOKEN_RENEW_MS);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it("timer skips nights and weekends even when enabled", async () => {
    vi.useFakeTimers();
    const renew = vi.fn(async () => ({ ok: true as const, rotated: false }));
    startEtradeAccessTokenKeepAlive({
      env: { NODE_ENV: "production" },
      now: () => zonedTimeToUtc(2026, 9, 5, 12, 0, 0, TZ),
      renew,
    });
    await vi.advanceTimersByTimeAsync(ETRADE_ACCESS_TOKEN_RENEW_MS);
    expect(renew).not.toHaveBeenCalled();
  });
});

describe("isEtradeCashSession", () => {
  it("is open weekdays 09:30–16:00 ET and closed nights/weekends", () => {
    expect(isEtradeCashSession(zonedTimeToUtc(2026, 8, 31, 9, 30, 0, TZ))).toBe(true);
    expect(isEtradeCashSession(zonedTimeToUtc(2026, 8, 31, 10, 0, 0, TZ))).toBe(true);
    expect(isEtradeCashSession(zonedTimeToUtc(2026, 8, 31, 16, 0, 0, TZ))).toBe(true);
    expect(isEtradeCashSession(zonedTimeToUtc(2026, 8, 31, 9, 29, 0, TZ))).toBe(false);
    expect(isEtradeCashSession(zonedTimeToUtc(2026, 8, 31, 16, 1, 0, TZ))).toBe(false);
    expect(isEtradeCashSession(zonedTimeToUtc(2026, 8, 31, 3, 0, 0, TZ))).toBe(false);
    expect(isEtradeCashSession(zonedTimeToUtc(2026, 9, 5, 12, 0, 0, TZ))).toBe(false);
  });
});

describe("etrade.ts stays chain-only with in-process renew", () => {
  it("never references order, preview, placeOrder, or accounts endpoints", () => {
    const src = readFileSync(resolve("server/src/etrade.ts"), "utf8");
    expect(src).toMatch(/renew_access_token/);
    expect(src).toMatch(/request_token/);
    expect(src).not.toMatch(/\/v1\/order/);
    expect(src).not.toMatch(/placeOrder/i);
    expect(src).not.toMatch(/previewOrder/i);
    expect(src).not.toMatch(/\/v1\/accounts/);
    const index = readFileSync(resolve("server/src/index.ts"), "utf8");
    expect(index).toMatch(/startEtradeAccessTokenKeepAlive/);
    expect(index).toMatch(/stopEtradeAccessTokenKeepAlive/);
  });
});

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

describe("POST /api/etrade/renew", () => {
  const realFetch = globalThis.fetch;
  const saved: Record<string, string | undefined> = {};
  const keys = [
    "ETRADE_ENV",
    "ETRADE_PROD_KEY",
    "ETRADE_PROD_SECRET",
    "ETRADE_PROD_ACCESS_TOKEN",
    "ETRADE_PROD_ACCESS_SECRET",
  ];

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function stashEnv() {
    for (const k of keys) saved[k] = process.env[k];
    process.env.ETRADE_ENV = "production";
    process.env.ETRADE_PROD_KEY = CONSUMER_KEY;
    process.env.ETRADE_PROD_SECRET = CONSUMER_SECRET;
    process.env.ETRADE_PROD_ACCESS_TOKEN = ACCESS_TOKEN;
    process.env.ETRADE_PROD_ACCESS_SECRET = ACCESS_SECRET;
  }

  function stubEtradeRenew(status: number, body: string) {
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
        return mockResponse(status, body);
      }),
    );
  }

  it("returns { ok: true } with no secrets on success", async () => {
    stashEnv();
    stubEtradeRenew(200, "Access Token has been renewed");
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const res = await realFetch(`${srv.url}/api/etrade/renew`, { method: "POST" });
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(res.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expectNoSecrets(JSON.stringify(body));
    } finally {
      await srv.close();
    }
  });

  it("returns { ok: false, error } on 401 with no secrets", async () => {
    stashEnv();
    stubEtradeRenew(401, `oauth_token=${LEAKED}`);
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const res = await realFetch(`${srv.url}/api/etrade/renew`, { method: "POST" });
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/HTTP 401/);
      expectNoSecrets(JSON.stringify(body));
    } finally {
      await srv.close();
    }
  });
});
