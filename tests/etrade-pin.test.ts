import {
  chmodSync,
  existsSync,
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
import { seedEvents } from "../shared/clock";
import type { CalendarEvent, StatusSnapshot } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import {
  completeEtradePinHandshake,
  etradeAuthState,
  resetEtradePinHandshake,
  startEtradePinHandshake,
} from "../server/src/etrade";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { StatusHub } from "../server/src/wsHub";

const CONSUMER_KEY = "ck-prod-TESTKEY";
const CONSUMER_SECRET = "cs-prod-TESTSECRET";
const ACCESS_TOKEN = "at-prod-TESTTOKEN";
const ACCESS_SECRET = "as-prod-TESTSECRET";
const REQUEST_TOKEN = "rt-prod-TESTTOKEN";
const REQUEST_SECRET = "rs-prod-TESTSECRET";
const NEW_TOKEN = "at-prod-NEWTOKEN";
const NEW_SECRET = "as-prod-NEWSECRET";
const PIN = "PIN1234";
const LEAKED = "leaked-oauth-token-SHOULD-NOT-PRINT";

const SECRET_NEVER = [
  CONSUMER_SECRET,
  ACCESS_TOKEN,
  ACCESS_SECRET,
  REQUEST_SECRET,
  NEW_TOKEN,
  NEW_SECRET,
  PIN,
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

function expectNoSecrets(output: string, allow: string[] = []) {
  for (const secret of SECRET_NEVER) {
    if (allow.includes(secret)) continue;
    expect(output).not.toContain(secret);
  }
}

function authorizeUrlOf(body: { authorizeUrl?: string }): string {
  expect(body.authorizeUrl).toEqual(expect.any(String));
  const url = body.authorizeUrl as string;
  expect(url).toMatch(/^https:\/\/us\.etrade\.com\/e\/t\/etws\/authorize\?/);
  expect(url).toContain(`key=${encodeURIComponent(CONSUMER_KEY)}`);
  expect(url).toContain(`token=${encodeURIComponent(REQUEST_TOKEN)}`);
  return url;
}

describe("startEtradePinHandshake / completeEtradePinHandshake", () => {
  const dirs: string[] = [];

  afterEach(() => {
    resetEtradePinHandshake();
    while (dirs.length) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir() {
    const dir = mkdtempSync(path.join(tmpdir(), "etrade-pin-"));
    dirs.push(dir);
    return dir;
  }

  it("start returns a URL-shaped authorize link and does not leak secrets in logs", async () => {
    const dir = tmpDir();
    const envFile = writeEnv(dir);
    const tmpFile = path.join(dir, ".env.etrade.oauth-tmp");
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.etrade.com/oauth/request_token");
      expect(url).not.toContain("/v1/order");
      expect(url).not.toContain("/v1/accounts");
      const auth = (init?.headers as { Authorization?: string } | undefined)?.Authorization ?? "";
      expect(auth).toMatch(/^OAuth /);
      expect(auth).toContain("oauth_callback=\"oob\"");
      expect(auth).not.toContain("oauth_token=");
      return mockResponse(200, `oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}`);
    });
    const got = await startEtradePinHandshake({
      env: prodEnv(),
      envFile,
      tmpFile,
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    expect(got.ok).toBe(true);
    if (!got.ok) throw new Error("expected start ok");
    authorizeUrlOf(got);
    expect(logs.join("\n")).toMatch(/\[EventGate\] etrade authorize started/);
    expectNoSecrets(logs.join("\n"));
    expect(logs.join("\n")).not.toMatch(/us\.etrade\.com\/e\/t\/etws\/authorize/);
    expect(logs.join("\n")).not.toContain(CONSUMER_KEY);
    expect(logs.join("\n")).not.toContain(REQUEST_TOKEN);
    expect(JSON.stringify(got)).not.toContain(CONSUMER_SECRET);
    expect(JSON.stringify(got)).not.toContain(REQUEST_SECRET);
    expect(JSON.stringify(got)).not.toContain(PIN);
    expect(existsSync(tmpFile)).toBe(true);
    expect(statSync(tmpFile).mode & 0o777).toBe(0o600);
  });

  it("pin exchange writes env keys, updates process.env, chmod 600, deletes request token", async () => {
    const dir = tmpDir();
    const envFile = writeEnv(dir);
    const tmpFile = path.join(dir, ".env.etrade.oauth-tmp");
    const env = prodEnv();
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/oauth/request_token")) {
        return mockResponse(200, `oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}`);
      }
      expect(url).toBe("https://api.etrade.com/oauth/access_token");
      expect(url).not.toContain("/v1/order");
      expect(url).not.toContain("/v1/accounts");
      const auth = (init?.headers as { Authorization?: string } | undefined)?.Authorization ?? "";
      expect(auth).toContain(`oauth_token="${REQUEST_TOKEN}"`);
      expect(auth).toContain(`oauth_verifier="${PIN}"`);
      return mockResponse(200, `oauth_token=${NEW_TOKEN}&oauth_token_secret=${NEW_SECRET}`);
    });
    const start = await startEtradePinHandshake({
      env,
      envFile,
      tmpFile,
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    expect(start.ok).toBe(true);
    const got = await completeEtradePinHandshake(PIN, {
      env,
      envFile,
      tmpFile,
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    expect(got).toEqual({ ok: true });
    expect(env.ETRADE_ENV).toBe("production");
    expect(env.ETRADE_PROD_ACCESS_TOKEN).toBe(NEW_TOKEN);
    expect(env.ETRADE_PROD_ACCESS_SECRET).toBe(NEW_SECRET);
    const written = readFileSync(envFile, "utf8");
    expect(written).toContain("ETRADE_ENV=production");
    expect(written).toContain(`ETRADE_PROD_ACCESS_TOKEN=${NEW_TOKEN}`);
    expect(written).toContain(`ETRADE_PROD_ACCESS_SECRET=${NEW_SECRET}`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(existsSync(tmpFile)).toBe(false);
    expect(etradeAuthState(env)).toBe("ok");
    expectNoSecrets(logs.join("\n"));
    expect(JSON.stringify(got)).not.toContain(NEW_TOKEN);
    expect(JSON.stringify(got)).not.toContain(PIN);
  });

  it("bad PIN fails closed with { ok: false } and does not rotate tokens", async () => {
    const dir = tmpDir();
    const envFile = writeEnv(dir);
    const tmpFile = path.join(dir, ".env.etrade.oauth-tmp");
    const env = prodEnv();
    const logs: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/oauth/request_token")) {
        return mockResponse(200, `oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}`);
      }
      return mockResponse(401, `oauth_token=${LEAKED}&oauth_token_secret=${LEAKED}`);
    });
    await startEtradePinHandshake({
      env,
      envFile,
      tmpFile,
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    const got = await completeEtradePinHandshake(PIN, {
      env,
      envFile,
      tmpFile,
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    expect(got.ok).toBe(false);
    if (got.ok) throw new Error("expected failure");
    expect(got.error).toMatch(/HTTP 401/);
    expect(env.ETRADE_PROD_ACCESS_TOKEN).toBe(ACCESS_TOKEN);
    expect(readFileSync(envFile, "utf8")).toContain(`ETRADE_PROD_ACCESS_TOKEN=${ACCESS_TOKEN}`);
    expectNoSecrets(logs.join("\n"));
    expectNoSecrets(JSON.stringify(got));
  });

  it("missing request token fails closed with { ok: false }", async () => {
    const logs: string[] = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("network should not be called");
    });
    const got = await completeEtradePinHandshake(PIN, {
      env: prodEnv(),
      fetch: fetchImpl,
      log: (m) => logs.push(String(m)),
    });
    expect(got).toEqual({ ok: false, error: "no request token", status: 400 });
    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoSecrets(logs.join("\n"));
    expectNoSecrets(JSON.stringify(got));
  });

  it("empty PIN fails closed without calling the network", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network should not be called");
    });
    const got = await completeEtradePinHandshake("  ", {
      env: prodEnv(),
      fetch: fetchImpl,
    });
    expect(got.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
    expectNoSecrets(JSON.stringify(got));
  });

  it("etradeAuthState is needs_pin without an access token and error without consumer keys", () => {
    expect(etradeAuthState(prodEnv({ ETRADE_PROD_ACCESS_TOKEN: "", ETRADE_PROD_ACCESS_SECRET: "" }))).toBe(
      "needs_pin",
    );
    expect(
      etradeAuthState({
        NODE_ENV: "test",
        ETRADE_ENV: "production",
      }),
    ).toBe("error");
    expect(etradeAuthState(prodEnv())).toBe("ok");
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

describe("POST /api/etrade/oauth/start and /pin", () => {
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
    resetEtradePinHandshake();
    vi.unstubAllGlobals();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function stashEnv(extras: Record<string, string> = {}) {
    for (const k of keys) saved[k] = process.env[k];
    process.env.ETRADE_ENV = "production";
    process.env.ETRADE_PROD_KEY = CONSUMER_KEY;
    process.env.ETRADE_PROD_SECRET = CONSUMER_SECRET;
    process.env.ETRADE_PROD_ACCESS_TOKEN = ACCESS_TOKEN;
    process.env.ETRADE_PROD_ACCESS_SECRET = ACCESS_SECRET;
    Object.assign(process.env, extras);
  }

  function stubEtradeOauth() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("127.0.0.1") || url.includes("localhost")) {
          return realFetch(input as RequestInfo, init);
        }
        expect(url).not.toContain("/v1/order");
        expect(url).not.toContain("/v1/accounts");
        if (url === "https://api.etrade.com/oauth/request_token") {
          return mockResponse(200, `oauth_token=${REQUEST_TOKEN}&oauth_token_secret=${REQUEST_SECRET}`);
        }
        if (url === "https://api.etrade.com/oauth/access_token") {
          const auth = String((init?.headers as { Authorization?: string } | undefined)?.Authorization ?? "");
          expect(auth).toContain(`oauth_verifier="${PIN}"`);
          return mockResponse(200, `oauth_token=${NEW_TOKEN}&oauth_token_secret=${NEW_SECRET}`);
        }
        throw new Error(`unexpected URL ${url.split("?")[0]}`);
      }),
    );
  }

  it("start returns a URL-shaped authorize link with no extra secrets", async () => {
    stashEnv();
    stubEtradeOauth();
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const res = await realFetch(`${srv.url}/api/etrade/oauth/start`, { method: "POST" });
      const body = (await res.json()) as { ok: boolean; authorizeUrl?: string; error?: string };
      expect(res.status).toBe(200);
      expect(body.ok).toBe(true);
      authorizeUrlOf(body);
      expectNoSecrets(JSON.stringify(body), []);
      expect(JSON.stringify(body)).not.toContain(CONSUMER_SECRET);
      expect(JSON.stringify(body)).not.toContain(REQUEST_SECRET);
    } finally {
      await srv.close();
    }
  });

  it("pin exchange returns { ok: true }, updates process.env, and leaks no secrets", async () => {
    stashEnv();
    stubEtradeOauth();
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const startRes = await realFetch(`${srv.url}/api/etrade/oauth/start`, { method: "POST" });
      expect(startRes.status).toBe(200);
      const pinRes = await realFetch(`${srv.url}/api/etrade/oauth/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN }),
      });
      const body = (await pinRes.json()) as { ok: boolean; error?: string };
      expect(pinRes.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expectNoSecrets(JSON.stringify(body));
      expect(process.env.ETRADE_PROD_ACCESS_TOKEN).toBe(NEW_TOKEN);
      expect(process.env.ETRADE_PROD_ACCESS_SECRET).toBe(NEW_SECRET);
    } finally {
      await srv.close();
    }
  });

  it("pin without a prior start fails closed with { ok: false }", async () => {
    stashEnv();
    stubEtradeOauth();
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const res = await realFetch(`${srv.url}/api/etrade/oauth/pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: PIN }),
      });
      const body = (await res.json()) as { ok: boolean; error?: string };
      expect(body.ok).toBe(false);
      expect(body.error).toMatch(/no request token/);
      expectNoSecrets(JSON.stringify(body));
    } finally {
      await srv.close();
    }
  });

  it("GET /api/status includes etradeAuth with no token material", async () => {
    stashEnv({ ETRADE_PROD_ACCESS_TOKEN: "", ETRADE_PROD_ACCESS_SECRET: "" });
    delete process.env.ETRADE_PROD_ACCESS_TOKEN;
    delete process.env.ETRADE_PROD_ACCESS_SECRET;
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const res = await realFetch(`${srv.url}/api/status`);
      const snap = (await res.json()) as StatusSnapshot;
      expect(snap.etradeAuth).toBe("needs_pin");
      const raw = JSON.stringify(snap);
      expect(raw).not.toContain(CONSUMER_SECRET);
      expect(raw).not.toMatch(/us\.etrade\.com\/e\/t\/etws\/authorize\?key=/);
      expect(Object.keys(snap)).toContain("etradeAuth");
    } finally {
      await srv.close();
    }
  });
});

describe("etrade.ts PIN handshake stays chain-only", () => {
  it("never references order, preview, placeOrder, or accounts endpoints", () => {
    const src = readFileSync(resolve("server/src/etrade.ts"), "utf8");
    expect(src).toMatch(/request_token/);
    expect(src).toMatch(/access_token/);
    expect(src).not.toMatch(/\/v1\/order/);
    expect(src).not.toMatch(/placeOrder/i);
    expect(src).not.toMatch(/previewOrder/i);
    expect(src).not.toMatch(/\/v1\/accounts/);
  });
});
