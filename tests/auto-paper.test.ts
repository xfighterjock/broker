import http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedEvents } from "../shared/clock";
import { REDIS_KEYS, SLEEVE_IDS } from "../shared/constants";
import {
  anyAutoPaperOn,
  applyAutoPaperPatch,
  defaultAutoPaperBySleeve,
  parseAutoPaperBody,
  parseAutoPaperRedis,
  serializeAutoPaperBySleeve,
  type AutoPaperBySleeve,
  type CalendarEvent,
  type StatusSnapshot,
} from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { StatusHub } from "../server/src/wsHub";
import type { RedisClient } from "../server/src/redis";

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

function memoryRedis(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  const client = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
      return "OK";
    },
  };
  return { store, client: client as unknown as RedisClient };
}

function makeTestApp(
  events: CalendarEvent[] = seedEvents(),
  redis: RedisClient | null = null,
) {
  const broker = new MockBroker();
  const engine = new GateEngine(broker, () => new Date(), () => events, {
    enabled: false,
    dailyLossUsd: 500,
  });
  const hub = new StatusHub();
  const app = buildApp({
    cfg: testCfg(),
    pool: null,
    redis,
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
  return { app, broker, engine };
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

describe("parseAutoPaperRedis migration", () => {
  it("maps legacy global 0 to all sleeves off", () => {
    const flags = parseAutoPaperRedis("0");
    expect(flags).toEqual(defaultAutoPaperBySleeve(false));
    expect(anyAutoPaperOn(flags!)).toBe(false);
  });

  it("maps legacy global 1 to all sleeves on", () => {
    const flags = parseAutoPaperRedis("1");
    expect(flags).toEqual(defaultAutoPaperBySleeve(true));
    expect(anyAutoPaperOn(flags!)).toBe(true);
  });

  it("reads structured JSON and leaves omitted sleeves off", () => {
    const flags = parseAutoPaperRedis(JSON.stringify({ day: false, riskoff: true }));
    expect(flags).toEqual({
      day: false,
      momentum: false,
      options: false,
      ownership: false,
      riskoff: true,
    });
    expect(anyAutoPaperOn(flags!)).toBe(true);
  });

  it("returns null for missing or junk so the in-memory default is kept", () => {
    expect(parseAutoPaperRedis(null)).toBeNull();
    expect(parseAutoPaperRedis("")).toBeNull();
    expect(parseAutoPaperRedis("not-json")).toBeNull();
    expect(parseAutoPaperRedis("{}")).toBeNull();
    expect(parseAutoPaperRedis(JSON.stringify({ day: "off" }))).toBeNull();
  });

  it("round-trips serialize → parse", () => {
    const flags: AutoPaperBySleeve = {
      day: false,
      momentum: true,
      options: false,
      ownership: true,
      riskoff: true,
    };
    expect(parseAutoPaperRedis(serializeAutoPaperBySleeve(flags))).toEqual(flags);
  });
});

describe("parseAutoPaperBody", () => {
  it("keeps { enabled } as set-all for old clients", () => {
    expect(parseAutoPaperBody({ enabled: true })).toEqual({ kind: "all", enabled: true });
    expect(parseAutoPaperBody({ enabled: false })).toEqual({ kind: "all", enabled: false });
    expect(parseAutoPaperBody({})).toEqual({ kind: "all", enabled: false });
  });

  it("accepts one sleeve or a batch", () => {
    expect(parseAutoPaperBody({ sleeveId: "day", enabled: false })).toEqual({
      kind: "one",
      sleeveId: "day",
      enabled: false,
    });
    expect(parseAutoPaperBody({ sleeves: { day: false, riskoff: true } })).toEqual({
      kind: "batch",
      sleeves: { day: false, riskoff: true },
    });
  });

  it("rejects unknown sleeveId and empty/invalid sleeves objects", () => {
    expect(parseAutoPaperBody({ sleeveId: "spy", enabled: true })).toEqual({
      error: "unknown sleeveId",
    });
    expect(parseAutoPaperBody({ sleeves: {} })).toEqual({
      error: "sleeves must include at least one known sleeveId",
    });
    expect(parseAutoPaperBody({ sleeves: { day: "off" } })).toEqual({
      error: "sleeves.day must be boolean",
    });
  });

  it("applies patches without flipping unspecified sleeves", () => {
    const start = defaultAutoPaperBySleeve(true);
    const dayOff = applyAutoPaperPatch(start, { kind: "one", sleeveId: "day", enabled: false });
    expect(dayOff.day).toBe(false);
    expect(dayOff.riskoff).toBe(true);
    const batch = applyAutoPaperPatch(dayOff, {
      kind: "batch",
      sleeves: { riskoff: false, momentum: true },
    });
    expect(batch).toEqual({
      day: false,
      momentum: true,
      options: true,
      ownership: true,
      riskoff: false,
    });
    expect(applyAutoPaperPatch(batch, { kind: "all", enabled: false })).toEqual(
      defaultAutoPaperBySleeve(false),
    );
  });
});

describe("POST /api/paper/auto + status snapshot", () => {
  let savedPassword: string | undefined;

  beforeEach(() => {
    savedPassword = process.env.GATE_PASSWORD;
    delete process.env.GATE_PASSWORD;
  });

  afterEach(() => {
    if (savedPassword === undefined) delete process.env.GATE_PASSWORD;
    else process.env.GATE_PASSWORD = savedPassword;
  });

  it("defaults all sleeves on when Redis has no key (in-memory)", async () => {
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/status`);
      const snap = (await res.json()) as StatusSnapshot;
      expect(snap.autoPaper).toBe(true);
      expect(snap.autoPaperBySleeve).toEqual(defaultAutoPaperBySleeve(true));
    } finally {
      await srv.close();
    }
  });

  it("migrates legacy Redis 0 to all-off JSON on first hydrate", async () => {
    const redis = memoryRedis({ [REDIS_KEYS.autoPaper]: "0" });
    const { app } = makeTestApp(seedEvents(), redis.client);
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/status`);
      const snap = (await res.json()) as StatusSnapshot;
      expect(snap.autoPaper).toBe(false);
      expect(snap.autoPaperBySleeve).toEqual(defaultAutoPaperBySleeve(false));
      expect(parseAutoPaperRedis(redis.store.get(REDIS_KEYS.autoPaper))).toEqual(
        defaultAutoPaperBySleeve(false),
      );
      expect(redis.store.get(REDIS_KEYS.autoPaper)).not.toBe("0");
    } finally {
      await srv.close();
    }
  });

  it("migrates legacy Redis 1 to all-on JSON on first hydrate", async () => {
    const redis = memoryRedis({ [REDIS_KEYS.autoPaper]: "1" });
    const { app } = makeTestApp(seedEvents(), redis.client);
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/status`);
      const snap = (await res.json()) as StatusSnapshot;
      expect(snap.autoPaper).toBe(true);
      expect(snap.autoPaperBySleeve).toEqual(defaultAutoPaperBySleeve(true));
      expect(redis.store.get(REDIS_KEYS.autoPaper)).not.toBe("1");
    } finally {
      await srv.close();
    }
  });

  it("can turn day off while riskoff stays on", async () => {
    const redis = memoryRedis({
      [REDIS_KEYS.autoPaper]: serializeAutoPaperBySleeve(defaultAutoPaperBySleeve(true)),
    });
    const { app } = makeTestApp(seedEvents(), redis.client);
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/auto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleeveId: "day", enabled: false }),
      });
      expect(res.status).toBe(200);
      const snap = (await res.json()) as StatusSnapshot;
      expect(snap.autoPaperBySleeve.day).toBe(false);
      expect(snap.autoPaperBySleeve.riskoff).toBe(true);
      expect(snap.autoPaper).toBe(true);
      const stored = parseAutoPaperRedis(redis.store.get(REDIS_KEYS.autoPaper));
      expect(stored?.day).toBe(false);
      expect(stored?.riskoff).toBe(true);
    } finally {
      await srv.close();
    }
  });

  it("batch update and old { enabled } still set all sleeves", async () => {
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const batch = await fetch(`${srv.url}/api/paper/auto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleeves: { day: false, riskoff: true, momentum: false } }),
      });
      const mid = (await batch.json()) as StatusSnapshot;
      expect(mid.autoPaperBySleeve.day).toBe(false);
      expect(mid.autoPaperBySleeve.riskoff).toBe(true);
      expect(mid.autoPaperBySleeve.options).toBe(true);
      expect(mid.autoPaper).toBe(true);

      const allOff = await fetch(`${srv.url}/api/paper/auto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      const snap = (await allOff.json()) as StatusSnapshot;
      expect(snap.autoPaper).toBe(false);
      expect(snap.autoPaperBySleeve).toEqual(defaultAutoPaperBySleeve(false));
    } finally {
      await srv.close();
    }
  });

  it("rejects an unknown sleeveId", async () => {
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/paper/auto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleeveId: "spy", enabled: true }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/unknown sleeveId/);
    } finally {
      await srv.close();
    }
  });

  it("lists every SLEEVE_IDS key on the snapshot", async () => {
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const snap = (await (await fetch(`${srv.url}/api/status`)).json()) as StatusSnapshot;
      expect(Object.keys(snap.autoPaperBySleeve).sort()).toEqual([...SLEEVE_IDS].sort());
    } finally {
      await srv.close();
    }
  });
});
