import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { seedEvents } from "../shared/clock";
import {
  ACTIVITY_LOG_PAGE_DEFAULT,
  ACTIVITY_LOG_PAGE_MAX,
  ACTIVITY_LOG_RETENTION_DAYS,
} from "../shared/constants";
import type { ActivityLogPage, StatusSnapshot } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import {
  clampActivityLimit,
  pageGateLog,
  pageMemoryLogs,
  parseActivityBefore,
  purgeExpiredLogs,
} from "../server/src/db";
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
  const engine = new GateEngine(broker, () => new Date(), () => seedEvents(), {
    enabled: false,
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
  return { app, engine };
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

type LogRow = { id: number; ts: Date; line: string };
type SessionRow = { id: number; ts: Date; event_type: string; notes: string };

class FakeLogPool {
  gate: LogRow[] = [];
  session: SessionRow[] = [];
  nextId = 1;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const text = sql.replace(/\s+/g, " ").trim();
    if (text.startsWith("SELECT id, ts, line FROM gate_log WHERE id <")) {
      const before = Number(params[0]);
      const limit = Number(params[1]);
      const rows = this.gate
        .filter((r) => r.id < before)
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("SELECT id, ts, line FROM gate_log ORDER BY id DESC")) {
      const limit = Number(params[0]);
      const rows = this.gate.slice().sort((a, b) => b.id - a.id).slice(0, limit);
      return { rows, rowCount: rows.length };
    }
    if (text.startsWith("DELETE FROM gate_log WHERE ts <")) {
      const cutoff = new Date(String(params[0])).getTime();
      const keep = this.gate.filter((r) => r.ts.getTime() >= cutoff);
      const n = this.gate.length - keep.length;
      this.gate = keep;
      return { rows: [], rowCount: n };
    }
    if (text.startsWith("DELETE FROM session_logs WHERE ts <")) {
      const cutoff = new Date(String(params[0])).getTime();
      const keep = this.session.filter((r) => r.ts.getTime() >= cutoff);
      const n = this.session.length - keep.length;
      this.session = keep;
      return { rows: [], rowCount: n };
    }
    throw new Error(`unexpected sql: ${text}`);
  }

  seedGate(line: string, ts: Date): LogRow {
    const row = { id: this.nextId++, ts, line };
    this.gate.push(row);
    return row;
  }

  seedSession(notes: string, ts: Date): SessionRow {
    const row = { id: this.nextId++, ts, event_type: "note", notes };
    this.session.push(row);
    return row;
  }
}

describe("activity log paging helpers", () => {
  it("clamps limit and parses before", () => {
    expect(ACTIVITY_LOG_RETENTION_DAYS).toBe(90);
    expect(clampActivityLimit(undefined)).toBe(ACTIVITY_LOG_PAGE_DEFAULT);
    expect(clampActivityLimit(0)).toBe(1);
    expect(clampActivityLimit(999)).toBe(ACTIVITY_LOG_PAGE_MAX);
    expect(parseActivityBefore("12")).toBe(12);
    expect(parseActivityBefore("nope")).toBeNull();
    expect(parseActivityBefore("-1")).toBeNull();
  });

  it("pages in-memory engine logs newest first", () => {
    const logs = [
      { ts: "2026-06-01T00:00:00.000Z", message: "oldest" },
      { ts: "2026-07-01T00:00:00.000Z", message: "mid" },
      { ts: "2026-08-01T00:00:00.000Z", message: "newest" },
    ];
    const first = pageMemoryLogs(logs, { limit: 2, before: null });
    expect(first.entries.map((e) => e.message)).toEqual(["newest", "mid"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toBe(2);
    const second = pageMemoryLogs(logs, { limit: 2, before: first.nextBefore });
    expect(second.entries.map((e) => e.message)).toEqual(["oldest"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextBefore).toBeNull();
  });
});

describe("activity log postgres paging and retention", () => {
  it("pages gate_log newest first with a before cursor", async () => {
    const pool = new FakeLogPool();
    const t0 = new Date("2026-06-01T00:00:00.000Z");
    pool.seedGate("oldest", t0);
    pool.seedGate("mid", new Date("2026-07-01T00:00:00.000Z"));
    pool.seedGate("newest", new Date("2026-08-01T00:00:00.000Z"));
    const first = await pageGateLog(pool as never, { limit: 2, before: null });
    expect(first.entries.map((e) => e.message)).toEqual(["newest", "mid"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toBe(2);
    const second = await pageGateLog(pool as never, { limit: 2, before: first.nextBefore });
    expect(second.entries.map((e) => e.message)).toEqual(["oldest"]);
    expect(second.hasMore).toBe(false);
    expect(second.nextBefore).toBeNull();
  });

  it("deletes gate_log and session_logs older than 90 days and keeps newer rows", async () => {
    const pool = new FakeLogPool();
    const now = new Date("2026-09-09T12:00:00.000Z");
    const old = new Date(now.getTime() - 91 * 24 * 60 * 60 * 1000);
    const keep = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    pool.seedGate("stale gate", old);
    pool.seedGate("fresh gate", keep);
    pool.seedSession("stale session", old);
    pool.seedSession("fresh session", keep);
    const dropped = await purgeExpiredLogs(pool as never, now, ACTIVITY_LOG_RETENTION_DAYS);
    expect(dropped.gateLog).toBe(1);
    expect(dropped.sessionLogs).toBe(1);
    expect(pool.gate.map((r) => r.line)).toEqual(["fresh gate"]);
    expect(pool.session.map((r) => r.notes)).toEqual(["fresh session"]);
    const page = await pageGateLog(pool as never, { limit: 50, before: null });
    expect(page.entries.map((e) => e.message)).toEqual(["fresh gate"]);
  });
});

describe("GET /api/activity and GET /api/status", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop();
      if (s) await s.close();
    }
  });

  it("serves newest-first pages without putting history on GET /api/status", async () => {
    const { app, engine } = makeTestApp();
    const srv = await listen(app);
    servers.push(srv);
    for (let i = 1; i <= 5; i++) engine.log(`marker-${i}`);
    const unique = "activity-log-unique-not-on-status";
    engine.log(unique);

    const statusRes = await fetch(`${srv.url}/api/status`);
    expect(statusRes.status).toBe(200);
    const snap = (await statusRes.json()) as StatusSnapshot;
    expect(snap.actionLog).toEqual([]);
    expect(snap.sessionLog).toEqual([]);
    expect(JSON.stringify(snap)).not.toContain(unique);
    expect(JSON.stringify(snap)).not.toContain("marker-5");

    const firstRes = await fetch(`${srv.url}/api/activity?limit=3`);
    expect(firstRes.status).toBe(200);
    const first = (await firstRes.json()) as ActivityLogPage;
    expect(first.entries[0]?.message).toContain(unique);
    expect(first.entries.map((e) => e.message).some((m) => m.includes("marker-5"))).toBe(true);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toEqual(expect.any(Number));
    expect(first.entries).toHaveLength(3);

    const secondRes = await fetch(
      `${srv.url}/api/activity?limit=3&before=${first.nextBefore}`,
    );
    const second = (await secondRes.json()) as ActivityLogPage;
    const ids = new Set(first.entries.map((e) => e.id));
    expect(second.entries.every((e) => !ids.has(e.id))).toBe(true);
    expect(second.entries[0]?.id ?? 0).toBeLessThan(first.entries[first.entries.length - 1]!.id);

    const alias = await fetch(`${srv.url}/api/log?limit=2`);
    const body = (await alias.json()) as ActivityLogPage & { log: ActivityLogPage["entries"] };
    expect(body.log).toEqual(body.entries);
    expect(body.entries[0]?.message).toContain(unique);
  });
});
