import express from "express";
import cookieParser from "cookie-parser";
import {
  DEFAULT_DAILY_LOSS_USD,
  GATED_ROOTS,
  MAX_QTY,
  REDIS_CHANNELS,
  REDIS_KEYS,
  TRADER,
  TZ,
} from "../../shared/constants";
import { computeClock } from "../../shared/clock";
import {
  emptyChecklist,
  emptyFreeze,
  type CalendarEvent,
  type Checklist,
  type FreezeCard,
  type StatusSnapshot,
} from "../../shared/types";
import {
  authRequired,
  gatePassword,
  isAuthed,
  requireAuth,
} from "./auth";
import type { AppConfig } from "./config";
import type { DbPool } from "./db";
import {
  insertFreeze,
  insertGateLog,
  insertSessionLog,
  latestFreeze,
  loadEvents,
  recentGateLog,
  recentSessionLogs,
  stampKnowledgeTime,
} from "./db";
import { GateEngine } from "./gate";
import { MockBroker } from "./mockBroker";
import type { RedisClient } from "./redis";
import type { StatusHub } from "./wsHub";

export interface AppDeps {
  cfg: AppConfig;
  pool: DbPool | null;
  redis: RedisClient | null;
  redisPub: RedisClient | null;
  broker: MockBroker;
  engine: GateEngine;
  getEvents: () => CalendarEvent[];
  setEvents: (events: CalendarEvent[]) => void;
  hub: StatusHub;
  brokerName: string;
  brokerMode: "mock" | "demo";
  liveRefused: boolean;
  stubNote: string | null;
}

function freezeFromRow(row: Awaited<ReturnType<typeof latestFreeze>>): {
  freeze: FreezeCard;
  knowledgeTime: string | null;
} {
  if (!row) return { freeze: emptyFreeze(), knowledgeTime: null };
  const consensus = row.consensus;
  const consensusObjects =
    typeof consensus === "string"
      ? consensus
      : consensus && typeof consensus === "object" && "text" in (consensus as object)
        ? String((consensus as { text: unknown }).text)
        : JSON.stringify(consensus ?? "");
  const contracts = (row.contracts ?? {}) as FreezeCard["liquidContracts"];
  return {
    freeze: {
      consensusObjects:
        typeof consensus === "object" && consensus && "text" in (consensus as object)
          ? String((consensus as { text: unknown }).text)
          : typeof consensus === "string"
            ? consensus
            : consensusObjects === "{}"
              ? ""
              : consensusObjects,
      sourceLabel: row.source ?? "",
      fedWatchSnapshot: row.fedwatch ?? "",
      liquidContracts: {
        MES: contracts.MES ?? "",
        ZN: contracts.ZN ?? "",
        M6E: contracts.M6E ?? "",
        SR3: contracts.SR3 ?? "",
      },
      freezeTimestamp: row.frozenAt,
    },
    knowledgeTime: row.knowledgeTime,
  };
}

export function buildApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "512kb" }));
  app.use(cookieParser());

  const memory = {
    freeze: emptyFreeze(),
    knowledgeTime: null as string | null,
    checklist: emptyChecklist(),
    sessionLog: [] as { ts: string; kind: string; message: string }[],
  };

  async function persistLog(line: string, ts: string): Promise<void> {
    if (deps.pool) {
      try {
        await insertGateLog(deps.pool, ts, line);
      } catch (err) {
        console.error("[EventGate] gate_log insert failed", err);
      }
    }
    if (deps.redisPub) {
      try {
        await deps.redisPub.publish(
          REDIS_CHANNELS.log,
          JSON.stringify({ ts, line }),
        );
      } catch {
        /* ignore */
      }
    }
    deps.hub.broadcast({ type: "log", ts, line });
  }

  deps.engine.onLog = (line, ts) => {
    void persistLog(line, ts);
  };

  function sessionNote(kind: string, message: string): void {
    const entry = { ts: new Date().toISOString(), kind, message };
    memory.sessionLog.push(entry);
    if (memory.sessionLog.length > 500) {
      memory.sessionLog.splice(0, memory.sessionLog.length - 500);
    }
    if (deps.pool) {
      void insertSessionLog(deps.pool, kind, memory.checklist, message);
    }
  }

  async function snapshot(): Promise<StatusSnapshot> {
    const now = new Date();
    const events = deps.getEvents();
    const clock = computeClock(now, events);
    let freeze = memory.freeze;
    let knowledgeTime = memory.knowledgeTime;
    if (deps.pool) {
      try {
        const row = await latestFreeze(deps.pool);
        const parsed = freezeFromRow(row);
        freeze = parsed.freeze;
        knowledgeTime = parsed.knowledgeTime;
        memory.freeze = freeze;
        memory.knowledgeTime = knowledgeTime;
      } catch {
        /* keep memory */
      }
    }
    let actionLog = deps.engine.getLogs();
    let sessionLog = memory.sessionLog;
    if (deps.pool) {
      try {
        const [g, s] = await Promise.all([
          recentGateLog(deps.pool, 200),
          recentSessionLogs(deps.pool, 200),
        ]);
        if (g.length) actionLog = g;
        if (s.length) sessionLog = s;
      } catch {
        /* keep memory */
      }
    }
    return {
      trader: TRADER,
      tz: TZ,
      clock,
      events,
      freeze,
      knowledgeTime,
      checklist: memory.checklist,
      sessionLog,
      actionLog,
      gateEnabled: deps.engine.enabled,
      dailyLossUsd: deps.engine.dailyLossUsd,
      qtyCap: MAX_QTY,
      gatedRoots: GATED_ROOTS,
      authRequired: authRequired(),
      broker: {
        name: deps.brokerName,
        mode: deps.brokerMode,
        liveRefused: deps.liveRefused,
        stubNote: deps.stubNote,
        orders: deps.broker.getOrdersSync(),
        positions: deps.broker.getPositionsSync(),
        dayPnl: deps.broker.getDayPnl(),
        account: "SIMULATION",
      },
    };
  }

  async function publishStatus(): Promise<void> {
    const snap = await snapshot();
    if (deps.redisPub) {
      try {
        await deps.redisPub.publish(REDIS_CHANNELS.status, JSON.stringify(snap));
      } catch {
        /* ignore */
      }
    }
    deps.hub.broadcast({ type: "status", payload: snap });
  }

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, authRequired: authRequired() });
  });

  app.get("/api/auth/status", (req, res) => {
    res.json({ authRequired: authRequired(), authed: isAuthed(req) });
  });

  app.post("/api/auth/login", (req, res) => {
    const password = String(req.body?.password ?? "");
    const expected = gatePassword();
    if (!expected) {
      res.json({ ok: true, authRequired: false });
      return;
    }
    if (password !== expected) {
      res.status(401).json({ error: "bad password" });
      return;
    }
    req.session.authed = true;
    req.session.save((err) => {
      if (err) {
        res.status(500).json({ error: "session save failed" });
        return;
      }
      res.json({ ok: true });
    });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.clearCookie("eg.sid", { path: "/" });
      res.json({ ok: true });
    });
  });

  app.use("/api", (req, res, next) => {
    if (
      req.path === "/health" ||
      req.path === "/auth/status" ||
      req.path === "/auth/login" ||
      req.path === "/auth/logout"
    ) {
      next();
      return;
    }
    requireAuth(req, res, next);
  });

  app.get("/api/status", async (_req, res) => {
    res.json(await snapshot());
  });

  app.get("/api/events", (_req, res) => {
    res.json({ events: deps.getEvents() });
  });

  app.get("/api/orders", (_req, res) => {
    res.json({
      orders: deps.broker.getOrdersSync(),
      positions: deps.broker.getPositionsSync(),
    });
  });

  app.get("/api/log", async (_req, res) => {
    if (deps.pool) {
      try {
        res.json({ log: await recentGateLog(deps.pool, 200) });
        return;
      } catch {
        /* fall through */
      }
    }
    res.json({ log: deps.engine.getLogs() });
  });

  app.get("/api/freeze", async (_req, res) => {
    if (deps.pool) {
      try {
        const row = await latestFreeze(deps.pool);
        const parsed = freezeFromRow(row);
        res.json({ freeze: parsed.freeze, knowledgeTime: parsed.knowledgeTime });
        return;
      } catch {
        /* fall through */
      }
    }
    res.json({ freeze: memory.freeze, knowledgeTime: memory.knowledgeTime });
  });

  app.put("/api/freeze", async (req, res) => {
    const body = req.body as Partial<FreezeCard>;
    memory.freeze = {
      consensusObjects: String(body.consensusObjects ?? memory.freeze.consensusObjects),
      sourceLabel: String(body.sourceLabel ?? memory.freeze.sourceLabel),
      fedWatchSnapshot: String(body.fedWatchSnapshot ?? memory.freeze.fedWatchSnapshot),
      liquidContracts: {
        MES: String(body.liquidContracts?.MES ?? memory.freeze.liquidContracts.MES),
        ZN: String(body.liquidContracts?.ZN ?? memory.freeze.liquidContracts.ZN),
        M6E: String(body.liquidContracts?.M6E ?? memory.freeze.liquidContracts.M6E),
        SR3: String(body.liquidContracts?.SR3 ?? memory.freeze.liquidContracts.SR3),
      },
      freezeTimestamp: new Date().toISOString(),
    };
    if (deps.pool) {
      try {
        await insertFreeze(deps.pool, {
          consensus: { text: memory.freeze.consensusObjects },
          source: memory.freeze.sourceLabel,
          fedwatch: memory.freeze.fedWatchSnapshot,
          contracts: memory.freeze.liquidContracts,
          knowledgeTime: memory.knowledgeTime,
          frozenAt: memory.freeze.freezeTimestamp,
        });
      } catch (err) {
        console.error("[EventGate] freeze insert failed", err);
      }
    }
    sessionNote("freeze", "freeze card saved");
    deps.engine.log("freeze card saved");
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/knowledge-time", async (_req, res) => {
    memory.knowledgeTime = new Date().toISOString();
    if (deps.pool) {
      try {
        await stampKnowledgeTime(deps.pool, new Date(memory.knowledgeTime));
      } catch (err) {
        console.error("[EventGate] knowledge_time stamp failed", err);
      }
    }
    sessionNote("knowledge_time", memory.knowledgeTime);
    deps.engine.log(`knowledge_time ${memory.knowledgeTime}`);
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/gate/enable", async (req, res) => {
    const enabled = req.body?.enabled === undefined ? true : Boolean(req.body.enabled);
    deps.engine.enabled = enabled;
    if (deps.redis) {
      await deps.redis.set(REDIS_KEYS.gateEnabled, enabled ? "1" : "0");
    }
    deps.engine.log(enabled ? "gate enabled" : "gate disabled");
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/flatten", async (_req, res) => {
    await deps.engine.flattenSleeve("manual");
    sessionNote("flatten", "manual flatten sleeve");
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/cancel-stops", async (_req, res) => {
    await deps.engine.cancelMarketStops();
    sessionNote("cancel", "manual cancel market/stops");
    await publishStatus();
    res.json(await snapshot());
  });

  app.post("/api/mock/inject-stop", async (req, res) => {
    const { symbol, type, side, qty, price, stopPrice } = req.body ?? {};
    if (!symbol) {
      res.status(400).json({ error: "symbol required" });
      return;
    }
    const order = deps.broker.injectOrder({
      symbol: String(symbol),
      type: type || "StopMarket",
      side: side === "Sell" ? "Sell" : "Buy",
      qty: Number(qty || 1),
      price: price === undefined ? undefined : Number(price),
      stopPrice: stopPrice === undefined ? undefined : Number(stopPrice),
    });
    deps.engine.log(
      `mock inject ${order.type} ${order.symbol} qty ${order.qty}`,
    );
    await publishStatus();
    res.json(await snapshot());
  });

  app.all("/api/checklist", async (req, res) => {
    const body = req.body as Partial<Checklist>;
    memory.checklist = { ...emptyChecklist(), ...memory.checklist, ...body };
    sessionNote("checklist", "checklist updated");
    await publishStatus();
    res.json(await snapshot());
  });

  app.all("/api/daily-loss", async (req, res) => {
    const n = Number(req.body?.dailyLossUsd);
    if (!Number.isFinite(n) || n < 0) {
      res.status(400).json({ error: "dailyLossUsd must be a non-negative number" });
      return;
    }
    deps.engine.dailyLossUsd = n;
    if (deps.redis) await deps.redis.set(REDIS_KEYS.dailyLoss, String(n));
    await publishStatus();
    res.json(await snapshot());
  });

  app.all("/api/day-pnl", async (req, res) => {
    const n = Number(req.body?.dayPnl);
    if (!Number.isFinite(n)) {
      res.status(400).json({ error: "dayPnl must be a number" });
      return;
    }
    deps.broker.setDayPnl(n);
    await publishStatus();
    res.json(await snapshot());
  });

  // Reload events from Postgres (or keep seed).
  app.post("/api/events/reload", async (_req, res) => {
    if (deps.pool) {
      try {
        deps.setEvents(await loadEvents(deps.pool));
        deps.engine.log(`reloaded calendar (${deps.getEvents().length} events)`);
      } catch (err) {
        deps.engine.log(`reload failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    await publishStatus();
    res.json(await snapshot());
  });

  return app;
}

export { DEFAULT_DAILY_LOSS_USD };
