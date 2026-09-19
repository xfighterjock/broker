import http from "node:http";
import express from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedEvents, zonedTimeToUtc } from "../shared/clock";
import { emptyFreeze, type CalendarEvent } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import {
  knowledgeTimeAlreadySetForEtDay,
  knowledgeTimeAnchorEvent,
  knowledgeTimeLogLine,
  shouldAutoStampKnowledgeTime,
} from "../server/src/knowledgeTime";
import { MockBroker } from "../server/src/mockBroker";
import { StatusHub } from "../server/src/wsHub";
import {
  MemoryUserDirectory,
  createUserWithPassword,
} from "../server/src/users";
import {
  DAY_STOCH_SYMBOL,
  dayStochArmed,
  decideDayMomentum,
  type MinuteBar,
} from "../server/src/dayMomentum";

const TEST_PASSWORD = "test-only-not-real-pass";
const OPS_TOKEN = "test-only-ops-token-not-a-secret";

const events = seedEvents();
const nfp = events.find((e) => e.type === "NFP")!;
const stmt = events.find((e) => e.type === "FOMC_STATEMENT")!;
const pc = events.find((e) => e.type === "FOMC_PC")!;

function freezeAt(iso: string) {
  return { ...emptyFreeze(), freezeTimestamp: iso };
}

describe("knowledge_time auto-stamp rules", () => {
  it("FOMC uses STATEMENT time when STATEMENT and PC both exist", () => {
    const afterStmt = new Date(stmt.timeUtc);
    expect(knowledgeTimeAnchorEvent(afterStmt, events)?.id).toBe(stmt.id);
    expect(knowledgeTimeAnchorEvent(afterStmt, events)?.type).toBe("FOMC_STATEMENT");
    expect(Date.parse(stmt.timeUtc)).toBeLessThan(Date.parse(pc.timeUtc));
  });

  it("does not auto-stamp FOMC before STATEMENT even if it is event day", () => {
    const before = new Date(Date.parse(stmt.timeUtc) - 1000);
    const got = shouldAutoStampKnowledgeTime({
      now: before,
      events,
      freeze: freezeAt("2026-09-16T14:00:00.000Z"),
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(false);
    expect(got.reason).toBe("before print");
    expect(got.event?.type).toBe("FOMC_STATEMENT");
  });

  it("auto-stamps FOMC at STATEMENT time with a freeze, not at PC", () => {
    const atStmt = new Date(stmt.timeUtc);
    const got = shouldAutoStampKnowledgeTime({
      now: atStmt,
      events,
      freeze: freezeAt("2026-09-16T16:00:00.000Z"),
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(true);
    expect(got.event?.type).toBe("FOMC_STATEMENT");
  });

  it("auto-stamps NFP at print time when a freeze exists", () => {
    const atPrint = new Date(nfp.timeUtc);
    const got = shouldAutoStampKnowledgeTime({
      now: atPrint,
      events,
      freeze: freezeAt("2026-09-04T11:00:00.000Z"),
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(true);
    expect(got.event?.type).toBe("NFP");
  });

  it("does not auto-stamp without a freeze", () => {
    const atPrint = new Date(nfp.timeUtc);
    const got = shouldAutoStampKnowledgeTime({
      now: atPrint,
      events,
      freeze: emptyFreeze(),
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(false);
    expect(got.reason).toBe("no freeze");
  });

  it("does not auto-stamp twice the same ET day", () => {
    const after = new Date(Date.parse(nfp.timeUtc) + 60_000);
    const first = after.toISOString();
    expect(knowledgeTimeAlreadySetForEtDay(after, first)).toBe(true);
    const got = shouldAutoStampKnowledgeTime({
      now: after,
      events,
      freeze: freezeAt("2026-09-04T11:00:00.000Z"),
      knowledgeTime: first,
    });
    expect(got.stamp).toBe(false);
    expect(got.reason).toBe("already stamped");
  });

  it("does not treat a leftover stamp from another ET day as set", () => {
    const after = new Date(nfp.timeUtc);
    expect(
      knowledgeTimeAlreadySetForEtDay(after, "2026-09-01T12:00:00.000Z"),
    ).toBe(false);
    const got = shouldAutoStampKnowledgeTime({
      now: after,
      events,
      freeze: freezeAt("2026-09-04T11:00:00.000Z"),
      knowledgeTime: "2026-09-01T12:00:00.000Z",
    });
    expect(got.stamp).toBe(true);
  });

  it("does not auto-stamp on a non-event day", () => {
    const got = shouldAutoStampKnowledgeTime({
      now: new Date("2026-09-19T15:00:00.000Z"),
      events,
      freeze: freezeAt("2026-09-19T14:00:00.000Z"),
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(false);
    expect(got.reason).toBe("no print event today");
  });

  it("logs distinguish auto / ops / manual", () => {
    const iso = "2026-09-16T18:00:00.000Z";
    expect(knowledgeTimeLogLine("auto", iso)).toBe(`knowledge_time auto-stamped ${iso}`);
    expect(knowledgeTimeLogLine("ops", iso)).toBe(`knowledge_time ops-stamped ${iso}`);
    expect(knowledgeTimeLogLine("manual", iso)).toBe(`knowledge_time manual ${iso}`);
  });
});

describe("day MES still requires knowledge_time (PR #42 idle-RTH block)", () => {
  function rth(hour: number, minute: number, close: number, extra: Partial<MinuteBar> = {}): MinuteBar {
    const ts = zonedTimeToUtc(2026, 9, 2, hour, minute, 0).getTime();
    return {
      ts,
      open: close,
      high: extra.high ?? close + 0.5,
      low: extra.low ?? close - 0.5,
      close,
      volume: extra.volume ?? 1000,
      ...extra,
      ts,
    };
  }

  function longSignalBars(): MinuteBar[] {
    const bars: MinuteBar[] = [];
    for (let i = 0; i < 22; i++) {
      const total = 9 * 60 + 30 + i * 5;
      bars.push(rth(Math.floor(total / 60), total % 60, 81, { high: 100, low: 80, volume: 1000 }));
    }
    bars[21] = { ...bars[21], close: 99, high: 100, low: 80 };
    return bars;
  }

  const noon = zonedTimeToUtc(2026, 9, 2, 11, 20, 0);
  const printDayKnowledge = zonedTimeToUtc(2026, 9, 2, 8, 35, 0).toISOString();

  it("blocks idle RTH MES without KT and allows the same signal after stamp", () => {
    const bars = longSignalBars();
    const blocked = decideDayMomentum({
      now: noon,
      gateMode: "idle",
      bars,
      positions: [],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      knowledgeTime: null,
    });
    expect(blocked.buy).toBeNull();
    expect(blocked.reason).toMatch(/knowledge_time/);
    expect(dayStochArmed(noon, null)).toBe(false);

    const allowed = decideDayMomentum({
      now: noon,
      gateMode: "idle",
      bars,
      positions: [],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      knowledgeTime: printDayKnowledge,
    });
    expect(dayStochArmed(noon, printDayKnowledge)).toBe(true);
    expect(allowed.buy?.symbol).toBe(DAY_STOCH_SYMBOL);
    expect(allowed.reason).toBe("buy");
  });
});

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
  opts: { now?: () => Date; events?: CalendarEvent[] } = {},
) {
  const broker = new MockBroker();
  const getNow = opts.now ?? (() => new Date());
  const getEvents = () => opts.events ?? seedEvents();
  const engine = new GateEngine(broker, getNow, getEvents, {
    enabled: false,
    dailyLossUsd: 500,
  });
  const api = buildApp({
    cfg: testCfg(),
    pool: null,
    redis: null,
    redisPub: null,
    broker,
    engine,
    getEvents,
    setEvents: () => {},
    hub: new StatusHub(),
    brokerName: "MockBroker",
    brokerMode: "mock",
    liveRefused: false,
    stubNote: null,
    users: dir,
    now: getNow,
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

describe("knowledge_time HTTP auto-stamp + ops", () => {
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

  it("auto-stamps at event time when a freeze card exists", async () => {
    const now = new Date(nfp.timeUtc);
    const dir = await seededUsers();
    const { app, engine } = makeApp(dir, { now: () => now });
    const srv = await listen(app);
    try {
      const freeze = await fetch(`${srv.url}/api/freeze`, {
        method: "PUT",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          consensusObjects: "NFP freeze",
          sourceLabel: "test",
          fedWatchSnapshot: "n/a",
          liquidContracts: { MES: "MESU6", ZN: "ZNU6", M6E: "M6EU6", SR3: "SR3U6" },
        }),
      });
      expect(freeze.status).toBe(200);
      const afterFreeze = (await freeze.json()) as { knowledgeTime?: string | null };
      expect(afterFreeze.knowledgeTime).toBeTruthy();

      const activity = await fetch(`${srv.url}/api/activity?limit=20`, {
        headers: {
          Authorization: `Bearer ${(
            await (
              await fetch(`${srv.url}/api/auth/login`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username: "event-gate", password: TEST_PASSWORD }),
              })
            ).json() as { token: string }
          ).token}`,
        },
      });
      expect(activity.status).toBe(200);
      const page = (await activity.json()) as { entries: { message: string }[] };
      expect(page.entries.some((e) => e.message.includes("knowledge_time auto-stamped"))).toBe(
        true,
      );
      expect(engine.getLogs().some((l) => l.message.includes("knowledge_time auto-stamped"))).toBe(
        true,
      );
    } finally {
      await srv.close();
    }
  });

  it("does not auto-stamp at event time without a freeze", async () => {
    const now = new Date(nfp.timeUtc);
    const dir = await seededUsers();
    const { app, engine } = makeApp(dir, { now: () => now });
    const srv = await listen(app);
    try {
      const status = await fetch(`${srv.url}/api/status`, { headers: opsHeaders() });
      expect(status.status).toBe(200);
      const snap = (await status.json()) as { knowledgeTime?: string | null };
      expect(snap.knowledgeTime).toBeNull();
      expect(engine.getLogs().some((l) => /knowledge_time/.test(l.message))).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it("does not auto-stamp FOMC before STATEMENT time", async () => {
    const now = new Date(Date.parse(stmt.timeUtc) - 1000);
    const dir = await seededUsers();
    const { app } = makeApp(dir, { now: () => now });
    const srv = await listen(app);
    try {
      const freeze = await fetch(`${srv.url}/api/freeze`, {
        method: "PUT",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          consensusObjects: "FOMC freeze",
          sourceLabel: "test",
          fedWatchSnapshot: "n/a",
          liquidContracts: { MES: "MESU6", ZN: "ZNU6", M6E: "M6EU6", SR3: "SR3U6" },
        }),
      });
      expect(freeze.status).toBe(200);
      const snap = (await freeze.json()) as { knowledgeTime?: string | null };
      expect(snap.knowledgeTime).toBeNull();
    } finally {
      await srv.close();
    }
  });

  it("does not write a second stamp the same ET day", async () => {
    const t0 = new Date(nfp.timeUtc);
    let now = t0;
    const dir = await seededUsers();
    const { app } = makeApp(dir, { now: () => now });
    const srv = await listen(app);
    try {
      const freeze = await fetch(`${srv.url}/api/freeze`, {
        method: "PUT",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({
          consensusObjects: "NFP freeze",
          sourceLabel: "test",
          fedWatchSnapshot: "n/a",
          liquidContracts: { MES: "MESU6", ZN: "ZNU6", M6E: "M6EU6", SR3: "SR3U6" },
        }),
      });
      const first = (await freeze.json()) as { knowledgeTime?: string | null };
      expect(first.knowledgeTime).toBe(t0.toISOString());

      now = new Date(t0.getTime() + 5 * 60_000);
      const again = await fetch(`${srv.url}/api/knowledge-time`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      expect(again.status).toBe(200);
      const second = (await again.json()) as { knowledgeTime?: string | null };
      expect(second.knowledgeTime).toBe(first.knowledgeTime);
    } finally {
      await srv.close();
    }
  });
});
