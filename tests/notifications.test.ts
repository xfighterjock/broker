import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedEvents } from "../shared/clock";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import {
  NotificationService,
  attachNotificationService,
  redactToken,
  resolvePushConfig,
  sendEventGateAlert,
  type EventGateAlertPayload,
  type NotificationProvider,
} from "../server/src/notifications";
import { StatusHub } from "../server/src/wsHub";

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
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
    pushFcmEnabled: false,
    pushFcmProjectId: undefined,
    pushFcmCredentialSource: "adc",
    pushFcmCredentialPath: undefined,
    pushDedupeWindowMinutes: 30,
    ...overrides,
  };
}

type TokenRow = {
  user_id: string;
  platform: string;
  token: string;
  token_hash: string;
  enabled: boolean;
  revoked_at: Date | null;
};

class FakePool {
  tokens = new Map<string, TokenRow>();
  dedupe = new Map<string, Date>();

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    if (sql.includes("SET token = $1, token_hash = $2") && sql.includes("token_hash = $7")) {
      const [token, tokenHash, _now, _label, userId, platform, replaceHash] = params as string[];
      const existing = this.tokens.get(replaceHash);
      if (existing && existing.user_id === userId && existing.platform === platform) {
        this.tokens.delete(replaceHash);
        this.tokens.set(tokenHash, {
          user_id: userId,
          platform,
          token,
          token_hash: tokenHash,
          enabled: true,
          revoked_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes("INSERT INTO notification_device_tokens")) {
      const [userId, platform, token, tokenHash] = params as string[];
      this.tokens.set(tokenHash, {
        user_id: userId,
        platform,
        token,
        token_hash: tokenHash,
        enabled: true,
        revoked_at: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET enabled = false")) {
      const [userId, platform, tokenHash] = params as string[];
      const row = this.tokens.get(tokenHash);
      if (row && row.user_id === userId && row.platform === platform) {
        row.enabled = false;
        row.revoked_at = new Date();
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT last_sent_at FROM notification_alert_dedupe")) {
      const key = String(params[0]);
      const found = this.dedupe.get(key);
      return { rows: found ? ([{ last_sent_at: found }] as T[]) : [], rowCount: found ? 1 : 0 };
    }
    if (sql.includes("INSERT INTO notification_alert_dedupe")) {
      this.dedupe.set(String(params[0]), new Date());
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SELECT token FROM notification_device_tokens")) {
      const userId = String(params[0]);
      const rows = [...this.tokens.values()]
        .filter((r) => r.user_id === userId && r.platform === "ios" && r.enabled && !r.revoked_at)
        .map((r) => ({ token: r.token })) as T[];
      return { rows, rowCount: rows.length };
    }
    if (sql.includes("COUNT(*)::text AS total")) {
      const all = [...this.tokens.values()].filter((r) => r.platform === "ios");
      const active = all.filter((r) => r.enabled && !r.revoked_at).length;
      const revoked = all.length - active;
      return {
        rows: [{ total: String(all.length), active: String(active), revoked: String(revoked) } as T],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }
}

function makeApp(notifications?: NotificationService) {
  const events = seedEvents();
  const broker = new MockBroker();
  const engine = new GateEngine(broker, () => new Date(), () => events, { enabled: false, dailyLossUsd: 500 });
  const app = buildApp({
    cfg: cfg(),
    pool: null,
    redis: null,
    redisPub: null,
    broker,
    engine,
    getEvents: () => events,
    setEvents: () => {},
    hub: new StatusHub(),
    brokerName: "MockBroker",
    brokerMode: "mock",
    liveRefused: false,
    stubNote: null,
    notifications,
  });
  return app;
}

async function listen(app: ReturnType<typeof buildApp>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no listen address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

describe("notifications service", () => {
  beforeEach(() => {
    delete process.env.GATE_PASSWORD;
  });
  afterEach(() => {
    delete process.env.GATE_PASSWORD;
  });

  it("returns disabled when FCM config is off", async () => {
    const svc = new NotificationService(null, cfg({ pushFcmEnabled: false }));
    const res = await svc.sendTest("event-gate");
    expect(res.outcome).toBe("disabled");
    expect(resolvePushConfig(cfg()).configured).toBe(false);
  });

  it("returns not_configured when enabled without project/credentials", async () => {
    const svc = new NotificationService(null, cfg({ pushFcmEnabled: true }));
    const res = await svc.sendTest("event-gate");
    expect(res.outcome).toBe("not_configured");
  });

  it("validates token format and supports replaceToken rotation", async () => {
    const pool = new FakePool();
    const provider: NotificationProvider = {
      name: "fcm",
      enabled: true,
      configured: true,
      send: async () => ({ ok: true }),
    };
    const svc = new NotificationService(pool as never, cfg({ pushFcmEnabled: true, pushFcmProjectId: "p" }), provider);
    const bad = await svc.registerToken({ principal: "u", platform: "ios", token: "bad" });
    expect(bad.ok).toBe(false);
    const first = await svc.registerToken({
      principal: "u",
      platform: "ios",
      token: "a".repeat(140),
      deviceLabel: "iphone",
    });
    expect(first.ok).toBe(true);
    const rotated = await svc.registerToken({
      principal: "u",
      platform: "ios",
      token: "b".repeat(140),
      replaceToken: "a".repeat(140),
    });
    expect(rotated.ok).toBe(true);
    const status = await svc.status();
    expect(status.tokens.active).toBe(1);
    expect(rotated.ok && rotated.tokenPreview).not.toContain("b".repeat(40));
  });

  it("dedupes repeated alert payloads in the configured window", async () => {
    const pool = new FakePool();
    let sends = 0;
    const provider: NotificationProvider = {
      name: "fcm",
      enabled: true,
      configured: true,
      send: async () => {
        sends += 1;
        return { ok: true };
      },
    };
    const svc = new NotificationService(pool as never, cfg({ pushFcmEnabled: true, pushFcmProjectId: "p" }), provider);
    await svc.registerToken({ principal: "u", platform: "ios", token: "z".repeat(140) });
    const payload: EventGateAlertPayload = {
      title: "A",
      body: "B",
      eventType: "risk_flip",
      occurredAt: new Date().toISOString(),
      dedupeKey: "rk:1",
      deepLinkRoute: "/status",
    };
    const first = await svc.sendAlert("u", payload);
    const second = await svc.sendAlert("u", payload);
    expect(first.outcome).toBe("delivered");
    expect(second.outcome).toBe("deduped");
    expect(sends).toBe(1);
  });

  it("reports provider send errors without token leakage", async () => {
    const pool = new FakePool();
    const provider: NotificationProvider = {
      name: "fcm",
      enabled: true,
      configured: true,
      send: async () => ({ ok: false, error: "fcm send failed" }),
    };
    const svc = new NotificationService(pool as never, cfg({ pushFcmEnabled: true, pushFcmProjectId: "p" }), provider);
    await svc.registerToken({ principal: "u", platform: "ios", token: "x".repeat(140) });
    const res = await svc.sendAlert("u", {
      title: "T",
      body: "B",
      eventType: "service_fault",
      occurredAt: new Date().toISOString(),
      dedupeKey: "svc:fault:1",
      deepLinkRoute: "/status",
    });
    expect(res.outcome).toBe("error");
    expect(JSON.stringify(res)).not.toContain("x".repeat(20));
  });

  it("auth-protects notification mutation and test endpoints", async () => {
    process.env.GATE_PASSWORD = "test-only-not-real";
    const app = makeApp();
    const srv = await listen(app);
    try {
      const registerRes = await fetch(`${srv.url}/api/notifications/tokens/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: "ios", token: "k".repeat(140) }),
      });
      const testRes = await fetch(`${srv.url}/api/notifications/test`, { method: "POST" });
      expect(registerRes.status).toBe(401);
      expect(testRes.status).toBe(401);
    } finally {
      await srv.close();
    }
  });

  it("test endpoint and health/status never echo tokens or credential paths", async () => {
    const pool = new FakePool();
    const token = "secretFcmTokenValue_".padEnd(140, "9");
    const provider: NotificationProvider = {
      name: "fcm",
      enabled: true,
      configured: true,
      send: async () => ({ ok: true }),
    };
    const svc = new NotificationService(
      pool as never,
      cfg({
        pushFcmEnabled: true,
        pushFcmProjectId: "p",
        pushFcmCredentialPath: "/root/secret-fcm.json",
      }),
      provider,
    );
    attachNotificationService(svc);
    await svc.registerToken({ principal: "event-gate", platform: "ios", token });
    const app = makeApp(svc);
    const srv = await listen(app);
    try {
      const health = await fetch(`${srv.url}/api/health`);
      const healthBody = await health.json();
      const statusRes = await fetch(`${srv.url}/api/notifications/status`);
      const statusBody = await statusRes.json();
      const testRes = await fetch(`${srv.url}/api/notifications/test`, { method: "POST" });
      const testBody = await testRes.json();
      const dumped = JSON.stringify({ healthBody, statusBody, testBody });
      expect(healthBody.notifications).toMatchObject({ provider: "fcm", enabled: true, configured: true });
      expect(healthBody.notifications.tokens).toBeUndefined();
      expect(statusBody.tokens.active).toBe(1);
      expect(testBody.outcome).toBe("delivered");
      expect(dumped).not.toContain(token);
      expect(dumped).not.toContain("/root/secret-fcm.json");
      expect(redactToken(token)).not.toBe(token);
    } finally {
      await srv.close();
      attachNotificationService(null);
    }
  });

  it("does not embed Firebase secrets, project IDs, or device tokens in source", () => {
    const src = [
      readFileSync(resolve("server/src/notifications.ts"), "utf8"),
      readFileSync(resolve(".env.example"), "utf8"),
      readFileSync(resolve("docs/DESIGN.md"), "utf8"),
    ].join("\n");
    expect(src).not.toMatch(/BEGIN PRIVATE KEY/);
    expect(src).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(src).not.toMatch(/[0-9]{12}:[A-Za-z0-9_-]{20,}/);
  });

  it("sendEventGateAlert is a no-op hook until a service is attached", async () => {
    attachNotificationService(null);
    const idle = await sendEventGateAlert("event-gate", {
      title: "t",
      body: "b",
      eventType: "risk_flip",
      occurredAt: new Date().toISOString(),
      dedupeKey: "risk:1",
      deepLinkRoute: "/status",
    });
    expect(idle.outcome).toBe("disabled");
  });
});
