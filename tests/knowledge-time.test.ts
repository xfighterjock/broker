import http from "node:http";
import express from "express";
import session from "express-session";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedEvents, zonedTimeToUtc } from "../shared/clock";
import type { CalendarEvent } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import {
  knowledgeTimeAlreadySetForEtDay,
  knowledgeTimeAnchorEvent,
  knowledgeTimeLogLine,
  knowledgeTimeManualAllowed,
  knowledgeTimeStampIsFinal,
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
const cpi = events.find((e) => e.type === "CPI")!;
const stmt = events.find((e) => e.type === "FOMC_STATEMENT")!;
const pc = events.find((e) => e.type === "FOMC_PC")!;

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
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(false);
    expect(got.reason).toBe("before print");
    expect(got.event?.type).toBe("FOMC_STATEMENT");
  });

  it("auto-stamps FOMC at STATEMENT time, not at PC", () => {
    const atStmt = new Date(stmt.timeUtc);
    const got = shouldAutoStampKnowledgeTime({
      now: atStmt,
      events,
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(true);
    expect(got.event?.type).toBe("FOMC_STATEMENT");
  });

  it("auto-stamps NFP at print time", () => {
    const atPrint = new Date(nfp.timeUtc);
    const got = shouldAutoStampKnowledgeTime({
      now: atPrint,
      events,
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(true);
    expect(got.event?.type).toBe("NFP");
  });

  it("auto-stamps CPI at print time with no freeze card", () => {
    const atPrint = new Date(cpi.timeUtc);
    const got = shouldAutoStampKnowledgeTime({
      now: atPrint,
      events,
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(true);
    expect(got.reason).toBe("auto");
    expect(got.event?.type).toBe("CPI");
  });

  it("auto-stamps NFP at print time with no freeze card", () => {
    const atPrint = new Date(nfp.timeUtc);
    const got = shouldAutoStampKnowledgeTime({
      now: atPrint,
      events,
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(true);
    expect(got.reason).toBe("auto");
    expect(got.event?.type).toBe("NFP");
  });

  it("does not auto-stamp jobless claims or other non-print events", () => {
    const claims: CalendarEvent = {
      id: "claims-2026-09-03",
      timeUtc: "2026-09-03T12:30:00.000Z",
      type: "JOBLESS_CLAIMS",
      flattenEt: "15:45",
    };
    const got = shouldAutoStampKnowledgeTime({
      now: new Date(claims.timeUtc),
      events: [claims],
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(false);
    expect(got.reason).toBe("no print event today");
    expect(got.event).toBeNull();
  });

  it("does not auto-stamp twice the same ET day", () => {
    const after = new Date(Date.parse(nfp.timeUtc) + 60_000);
    const first = after.toISOString();
    expect(knowledgeTimeAlreadySetForEtDay(after, first)).toBe(true);
    const got = shouldAutoStampKnowledgeTime({
      now: after,
      events,
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
      knowledgeTime: "2026-09-01T12:00:00.000Z",
    });
    expect(got.stamp).toBe(true);
  });

  it("does not auto-stamp on a non-event day", () => {
    const got = shouldAutoStampKnowledgeTime({
      now: new Date("2026-09-19T15:00:00.000Z"),
      events,
      knowledgeTime: null,
    });
    expect(got.stamp).toBe(false);
    expect(got.reason).toBe("no print event today");
  });

  it("does not treat a pre-print stamp as final, so auto-stamp can still fire", () => {
    const before = "2026-09-04T12:00:00.000Z";
    const after = new Date(nfp.timeUtc);
    expect(knowledgeTimeStampIsFinal(after, before, events)).toBe(false);
    const got = shouldAutoStampKnowledgeTime({
      now: after,
      events,
      knowledgeTime: before,
    });
    expect(got.stamp).toBe(true);
    expect(got.reason).toBe("auto");
  });

  it("refuses a manual stamp on a non-print day and before the print", () => {
    const claims = knowledgeTimeManualAllowed(new Date("2026-10-08T18:39:00.000Z"), events);
    expect(claims.ok).toBe(false);
    expect(claims.reason).toBe("knowledge_time not on a print day");
    const early = knowledgeTimeManualAllowed(new Date(Date.parse(nfp.timeUtc) - 60_000), events);
    expect(early.ok).toBe(false);
    expect(early.reason).toBe("knowledge_time before print");
    const atPrint = knowledgeTimeManualAllowed(new Date(nfp.timeUtc), events);
    expect(atPrint.ok).toBe(true);
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
  const sept2Print: CalendarEvent = {
    id: "nfp-2026-09-02",
    timeUtc: zonedTimeToUtc(2026, 9, 2, 8, 30, 0).toISOString(),
    type: "NFP",
    flattenEt: "15:45",
  };

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
      events: [sept2Print],
    });
    expect(dayStochArmed(noon, printDayKnowledge, [sept2Print])).toBe(true);
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

  it("auto-stamps at NFP time with no freeze card", async () => {
    const now = new Date(nfp.timeUtc);
    const dir = await seededUsers();
    const { app, engine } = makeApp(dir, { now: () => now });
    const srv = await listen(app);
    try {
      const status = await fetch(`${srv.url}/api/status`, { headers: opsHeaders() });
      expect(status.status).toBe(200);
      const snap = (await status.json()) as {
        knowledgeTime?: string | null;
        stage3Armed?: boolean;
        calendarStale?: boolean;
        freeze?: { freezeTimestamp?: string | null };
      };
      expect(snap.freeze?.freezeTimestamp ?? null).toBeNull();
      expect(snap.knowledgeTime).toBe(now.toISOString());
      expect(snap.stage3Armed).toBe(true);
      expect(snap.calendarStale).toBe(false);
      expect(engine.getLogs().some((l) => l.message.includes("knowledge_time auto-stamped"))).toBe(
        true,
      );

      const again = await fetch(`${srv.url}/api/status`, { headers: opsHeaders() });
      const second = (await again.json()) as { knowledgeTime?: string | null };
      expect(second.knowledgeTime).toBe(snap.knowledgeTime);
      expect(
        engine.getLogs().filter((l) => l.message.includes("knowledge_time auto-stamped")),
      ).toHaveLength(1);
    } finally {
      await srv.close();
    }
  });

  it("auto-stamps at CPI time with no freeze card", async () => {
    const now = new Date(cpi.timeUtc);
    const dir = await seededUsers();
    const { app, engine } = makeApp(dir, { now: () => now });
    const srv = await listen(app);
    try {
      const status = await fetch(`${srv.url}/api/status`, { headers: opsHeaders() });
      expect(status.status).toBe(200);
      const snap = (await status.json()) as { knowledgeTime?: string | null };
      expect(snap.knowledgeTime).toBe(now.toISOString());
      expect(engine.getLogs().some((l) => l.message.includes("knowledge_time auto-stamped"))).toBe(
        true,
      );
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

  it("sets calendarStale when no print falls in the next 35 days", async () => {
    const now = new Date("2026-10-09T20:00:00.000Z");
    const september = seedEvents().filter((e) => e.timeUtc < "2026-10-01");
    const dir = await seededUsers();
    const { app } = makeApp(dir, { now: () => now, events: september });
    const srv = await listen(app);
    try {
      const status = await fetch(`${srv.url}/api/status`, { headers: opsHeaders() });
      expect(status.status).toBe(200);
      const snap = (await status.json()) as {
        calendarStale?: boolean;
        clock?: { nextEvent?: { id?: string } | null; mode?: string };
      };
      expect(snap.calendarStale).toBe(true);
      expect(snap.clock?.nextEvent ?? null).toBeNull();
      expect(snap.clock?.mode).toBe("idle");
    } finally {
      await srv.close();
    }
  });

  it("refuses POST /api/knowledge-time on a non-print ET day and does not stamp", async () => {
    const now = new Date("2026-10-08T18:39:00.000Z");
    const dir = await seededUsers();
    const { app, engine } = makeApp(dir, { now: () => now });
    const srv = await listen(app);
    try {
      const stamp = await fetch(`${srv.url}/api/knowledge-time`, {
        method: "POST",
        headers: { ...opsHeaders(), "Content-Type": "application/json" },
        body: "{}",
      });
      expect(stamp.status).toBe(409);
      const body = (await stamp.json()) as {
        error?: string;
        knowledgeTime?: string | null;
        stage3Armed?: boolean;
        calendarStale?: boolean;
      };
      expect(body.error).toBe("knowledge_time not on a print day");
      expect(body.knowledgeTime ?? null).toBeNull();
      expect(body.stage3Armed).toBe(false);
      expect(body.calendarStale).toBe(false);
      expect(
        engine.getLogs().some((l) => l.message.includes("knowledge_time refused (ops)")),
      ).toBe(true);
      expect(
        engine.getLogs().some((l) => l.message.includes("knowledge_time not on a print day")),
      ).toBe(true);
    } finally {
      await srv.close();
    }
  });
});
