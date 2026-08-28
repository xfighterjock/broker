import http from "node:http";
import express from "express";
import session from "express-session";
import { REDIS_KEYS } from "../../shared/constants";
import { seedEvents } from "../../shared/clock";
import type { CalendarEvent } from "../../shared/types";
import { buildApp, stopAutoPaperLoop } from "./app";
import { authRequired, buildSessionMiddleware, gatePassword } from "./auth";
import { loadConfig } from "./config";
import { maybeLoadAppDotenv } from "./massive";
import { createPool, loadEvents, recentGateLog, runMigrations } from "./db";
import { GateEngine } from "./gate";
import { MockBroker } from "./mockBroker";
import { connectRedis } from "./redis";
import { createTradovateFromEnv } from "./tradovateBroker";
import { attachScanRedis, kickScan } from "./scan";
import { StatusHub } from "./wsHub";

async function main(): Promise<void> {
  maybeLoadAppDotenv();
  const cfg = loadConfig();

  let pool = null as ReturnType<typeof createPool> | null;
  try {
    pool = createPool(cfg.databaseUrl);
    await pool.query("SELECT 1");
    await runMigrations(pool);
    console.log("[EventGate] postgres connected, migrations applied");
  } catch (err) {
    console.warn(
      "[EventGate] postgres unavailable — running with seed events and in-memory freeze/log.",
      err instanceof Error ? err.message : err,
    );
    if (pool) {
      try {
        await pool.end();
      } catch {
        /* ignore */
      }
      pool = null;
    }
    if (cfg.nodeEnv === "production") {
      console.error("[EventGate] postgres is required in production. Exiting.");
      process.exit(1);
    }
  }

  let redis = null as Awaited<ReturnType<typeof connectRedis>> | null;
  try {
    redis = await connectRedis(cfg.redisUrl);
    await redis.client.ping();
    console.log("[EventGate] redis connected");
  } catch (err) {
    console.warn(
      "[EventGate] redis unavailable — sessions will be memory-only; mock book will not survive restart.",
      err instanceof Error ? err.message : err,
    );
    redis = null;
    if (cfg.nodeEnv === "production") {
      console.error("[EventGate] redis is required in production. Exiting.");
      process.exit(1);
    }
  }

  let events: CalendarEvent[] = seedEvents();
  if (pool) {
    try {
      const fromDb = await loadEvents(pool);
      if (fromDb.length) events = fromDb;
    } catch (err) {
      console.warn("[EventGate] could not load events from postgres", err);
    }
  }

  const mock = new MockBroker();
  if (redis) {
    mock.attachRedis(redis.client);
    await mock.loadFromRedis();
  }

  let brokerName = "MockBroker";
  let brokerMode: "mock" | "demo" = "mock";
  let liveRefused = false;
  let stubNote: string | null = null;

  if (cfg.tradingMode === "tradovate" || cfg.tradingMode === "demo") {
    try {
      createTradovateFromEnv();
      stubNote =
        "TradovateDemoBroker constructed (stub). REST against demo.tradovateapi.com only. Order/position calls are not wired — gate still uses MockBroker so the dashboard is usable. Keep TRADING_MODE=mock unless you finish the stub.";
      brokerName = "TradovateDemoBroker (stub) + MockBroker";
      brokerMode = "demo";
      console.warn("[EventGate]", stubNote);
    } catch (err) {
      liveRefused = true;
      stubNote = err instanceof Error ? err.message : String(err);
      console.error("[EventGate]", stubNote);
    }
  }

  let enabled = true;
  let dailyLoss = 500;
  if (redis) {
    const e = await redis.client.get(REDIS_KEYS.gateEnabled);
    if (e === "0") enabled = false;
    if (e === "1") enabled = true;
    const d = await redis.client.get(REDIS_KEYS.dailyLoss);
    if (d !== null && Number.isFinite(Number(d))) dailyLoss = Number(d);
  }

  const engine = new GateEngine(
    mock,
    () => new Date(),
    () => events,
    { enabled, dailyLossUsd: dailyLoss },
  );
  if (pool) {
    try {
      engine.loadLogs(await recentGateLog(pool, 200));
    } catch {
      /* ignore */
    }
  }
  if (redis) {
    const fired = await redis.client.get(REDIS_KEYS.flattenFired);
    if (fired) engine.flattenFiredKey = fired;
  }

  const hub = new StatusHub();
  const api = buildApp({
    cfg,
    pool,
    redis: redis?.client ?? null,
    redisPub: redis?.pub ?? null,
    broker: mock,
    engine,
    getEvents: () => events,
    setEvents: (next) => {
      events = next;
    },
    hub,
    brokerName,
    brokerMode,
    liveRefused,
    stubNote,
  });

  const sessionSecret = gatePassword() || "dev-only-not-for-prod";
  const sessionMw = redis
    ? buildSessionMiddleware(redis.client, sessionSecret, cfg.cookieSecure)
    : session({
        name: "eg.sid",
        secret: sessionSecret,
        resave: false,
        saveUninitialized: false,
        cookie: {
          httpOnly: true,
          sameSite: "lax",
          secure: cfg.cookieSecure,
          maxAge: 7 * 24 * 3600 * 1000,
          path: "/",
        },
      });

  const root = express();
  root.disable("x-powered-by");
  root.use(sessionMw);
  root.use(api);

  engine.log(
    `started mode=${cfg.tradingMode} bind=${cfg.bind}:${cfg.port} auth=${authRequired() ? "on" : "OFF (dev)"} pg=${pool ? "on" : "off"} redis=${redis ? "on" : "off"}`,
  );

  let tickHandle: ReturnType<typeof setInterval> | null = null;
  function startTicker(): void {
    if (tickHandle) return;
    tickHandle = setInterval(() => {
      if (!engine.enabled) return;
      engine
        .tick()
        .then(async () => {
          if (redis) {
            await redis.client.set(REDIS_KEYS.gateEnabled, engine.enabled ? "1" : "0");
            if (engine.flattenFiredKey) {
              await redis.client.set(REDIS_KEYS.flattenFired, engine.flattenFiredKey);
            }
          }
        })
        .catch((err) => {
          engine.log(`tick error: ${err instanceof Error ? err.message : String(err)}`);
        });
    }, 1000);
  }
  if (engine.enabled) startTicker();

  const enableWatch = setInterval(() => {
    if (engine.enabled && !tickHandle) startTicker();
  }, 500);

  const server = http.createServer(root);
  hub.attach(server, (req, _res, next) => {
    (sessionMw as (req: unknown, res: unknown, next: () => void) => void)(req, {}, next);
  });

  attachScanRedis(redis?.client ?? null);
  kickScan();

  server.listen(cfg.port, cfg.bind, () => {
    console.log(`[EventGate] listening on ${cfg.bind}:${cfg.port}`);
    console.log(`[EventGate] trading mode ${cfg.tradingMode}`);
    console.log(`[EventGate] GATE_PASSWORD ${authRequired() ? "set" : "UNSET"}`);
  });

  const shutdown = async () => {
    clearInterval(enableWatch);
    if (tickHandle) clearInterval(tickHandle);
    stopAutoPaperLoop();
    server.close();
    if (pool) await pool.end();
    if (redis) {
      await redis.client.quit();
      await redis.pub.quit();
      await redis.sub.quit();
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

main().catch((err) => {
  console.error("[EventGate] fatal", err);
  process.exit(1);
});
