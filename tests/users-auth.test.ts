import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedEvents } from "../shared/clock";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { StatusHub } from "../server/src/wsHub";
import {
  MemoryUserDirectory,
  createUserWithPassword,
  hashPassword,
  resetLoginFailures,
  verifyPassword,
  verifyPasswordAgainstUser,
} from "../server/src/users";

const TEST_PASSWORD = "test-only-not-real-pass";

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
  root.use(
    session({
      name: "eg.sid",
      secret: "test-only-not-real",
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: "lax", secure: false, path: "/" },
    }),
  );
  root.use(api);
  return root;
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

describe("users password hash", () => {
  it("hashes with argon2id and verifies; wrong password fails", async () => {
    const hash = await hashPassword(TEST_PASSWORD);
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, TEST_PASSWORD)).toBe(true);
    expect(await verifyPassword(hash, "wrong-password-not-real")).toBe(false);
  });

  it("missing or disabled users fail closed without throwing", async () => {
    expect(await verifyPasswordAgainstUser(null, TEST_PASSWORD)).toBe(false);
    const dir = new MemoryUserDirectory();
    await createUserWithPassword(dir, "disabled", TEST_PASSWORD);
    const user = await dir.findByUsername("disabled");
    expect(user).toBeTruthy();
    user!.disabledAt = new Date();
    expect(await verifyPasswordAgainstUser(user, TEST_PASSWORD)).toBe(false);
  });
});

describe("users table migration", () => {
  it("defines users and user_sessions without plaintext password columns", () => {
    const sql = readFileSync(resolve("db/migrations/003_users.sql"), "utf8");
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS users/);
    expect(sql).toMatch(/username\s+text NOT NULL UNIQUE/);
    expect(sql).toMatch(/password_hash/);
    expect(sql).toMatch(/disabled_at/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS user_sessions/);
    expect(sql).toMatch(/token_hash/);
    expect(sql).not.toMatch(/^\s*password\s+text/m);
  });
});

describe("users AUTH_MODE login", () => {
  const savedMode = process.env.AUTH_MODE;
  const savedPassword = process.env.GATE_PASSWORD;

  beforeEach(() => {
    process.env.AUTH_MODE = "users";
    delete process.env.GATE_PASSWORD;
    resetLoginFailures();
  });

  afterEach(() => {
    if (savedMode === undefined) delete process.env.AUTH_MODE;
    else process.env.AUTH_MODE = savedMode;
    if (savedPassword === undefined) delete process.env.GATE_PASSWORD;
    else process.env.GATE_PASSWORD = savedPassword;
    resetLoginFailures();
  });

  it("rejects wrong password and does not issue a token", async () => {
    const dir = await seededUsers();
    const srv = await listen(makeApp(dir));
    try {
      const res = await fetch(`${srv.url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "event-gate", password: "nope-not-real" }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error?: string; token?: string };
      expect(body.error).toBe("invalid credentials");
      expect(body.token).toBeUndefined();
    } finally {
      await srv.close();
    }
  });

  it("logs in with username/password and returns a bearer token", async () => {
    const dir = await seededUsers();
    const srv = await listen(makeApp(dir));
    try {
      const res = await fetch(`${srv.url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "Event-Gate", password: TEST_PASSWORD }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok?: boolean; username?: string; token?: string };
      expect(body.ok).toBe(true);
      expect(body.username).toBe("event-gate");
      expect(typeof body.token).toBe("string");
      expect(body.token!.length).toBeGreaterThan(20);
      expect(JSON.stringify(body)).not.toContain(TEST_PASSWORD);
    } finally {
      await srv.close();
    }
  });

  it("does not accept GATE_PASSWORD as the users-table login", async () => {
    process.env.GATE_PASSWORD = "legacy-shared-not-real";
    const dir = await seededUsers();
    const srv = await listen(makeApp(dir));
    try {
      const res = await fetch(`${srv.url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "event-gate", password: "legacy-shared-not-real" }),
      });
      expect(res.status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it("401s protected APIs without a session and allows them with bearer", async () => {
    const dir = await seededUsers();
    const srv = await listen(makeApp(dir));
    try {
      const denied = await fetch(`${srv.url}/api/status`);
      expect(denied.status).toBe(401);
      const publicRisk = await fetch(`${srv.url}/api/public/risk`);
      expect(publicRisk.status).toBe(200);

      const login = await fetch(`${srv.url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "event-gate", password: TEST_PASSWORD }),
      });
      const body = (await login.json()) as { token: string };
      const ok = await fetch(`${srv.url}/api/status`, {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(ok.status).toBe(200);
      const snap = (await ok.json()) as { gateEnabled?: boolean };
      expect(typeof snap.gateEnabled).toBe("boolean");

      await fetch(`${srv.url}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${body.token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      const after = await fetch(`${srv.url}/api/status`, {
        headers: { Authorization: `Bearer ${body.token}` },
      });
      expect(after.status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it("sets a cookie session that /api/auth/status sees as authed", async () => {
    const dir = await seededUsers();
    const srv = await listen(makeApp(dir));
    try {
      const login = await fetch(`${srv.url}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "event-gate", password: TEST_PASSWORD }),
      });
      const cookie = login.headers.get("set-cookie") ?? "";
      expect(cookie).toMatch(/eg\.sid=/);
      const st = await fetch(`${srv.url}/api/auth/status`, { headers: { Cookie: cookie.split(";")[0] } });
      const body = (await st.json()) as { authed?: boolean; mode?: string; username?: string };
      expect(body.authed).toBe(true);
      expect(body.mode).toBe("users");
      expect(body.username).toBe("event-gate");
    } finally {
      await srv.close();
    }
  });
});
