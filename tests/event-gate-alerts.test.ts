import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeClock, seedEvents } from "../shared/clock";
import { REDIS_KEYS } from "../shared/constants";
import { defaultSleeves, emptyFreeze, type SleeveBook, type SleeveId } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { StatusHub } from "../server/src/wsHub";
import {
  EVENT_GATE_ALERT_PRINCIPAL,
  FREEZE_MISSING_LEAD_MS,
  OI_SKIP_STREAK_N,
  considerClockAlerts,
  considerGateTickAlerts,
  considerSleeveLossWarn,
  noteCreditLegOiSkip,
  noteServiceDown,
  noteServiceUp,
  notifyCreditPutOpened,
  notifyCreditPutRiskOnFlatten,
  notifyCreditPutStopped,
  notifyDayFill,
  notifyDayFlatten,
  notifyDayLossCap,
  notifyEtradeRenewFailed,
  notifyOverlayRotation,
  notifyVetoConfirm,
  resetEventGateAlertState,
  resetOiSkipStreak,
  riskFlipBody,
  riskFlipDedupeKey,
  riskFlipTitle,
} from "../server/src/eventGateAlerts";
import {
  applyResolvedRisk,
  attachRiskRedis,
  ensureRisk,
  getLastKnownRiskOn,
  resetRiskCache,
  RISK_CACHE_MS,
  riskFromFeatures,
  seedPersistedRiskOn,
  type RiskSnapshot,
} from "../server/src/risk";
import { resetMassiveCache } from "../server/src/massive";
import {
  attachNotificationService,
  type EventGateAlertPayload,
  type NotificationService,
  type SendResult,
} from "../server/src/notifications";
import type { ScanFeatures } from "../server/src/scan";
import type { RedisClient } from "../server/src/redis";
import { barsCloses, clearMassiveTestKey, setMassiveTestKey, stubMarketFetch } from "./helpers/massiveStub";

function feat(above200: boolean): ScanFeatures {
  return {
    last: 100,
    sma20: 99,
    sma200: above200 ? 90 : 110,
    high52: 101,
    pctFrom52: -0.01,
    dist20: 0.01,
    above200,
    ret63: 0.1,
    ret126: 0.2,
    ret252: 0.3,
    has252: true,
    volx: 1,
  };
}

function onSnap(): RiskSnapshot {
  return riskFromFeatures({
    spy: feat(true),
    acwi: feat(true),
    hyg: feat(true),
    uup20dPct: 0.01,
  });
}

function offSnap(): RiskSnapshot {
  return riskFromFeatures({
    spy: feat(true),
    acwi: feat(true),
    hyg: feat(false),
    uup20dPct: 0.01,
  });
}

function delivered(): SendResult {
  return { outcome: "delivered", provider: "fcm", attempted: 1, delivered: 1, failed: 0, skipped: 0 };
}

function countingService() {
  const calls: { principal: string; payload: EventGateAlertPayload }[] = [];
  const svc = {
    async sendAlert(principal: string, payload: EventGateAlertPayload) {
      calls.push({ principal, payload });
      return delivered();
    },
    async status() {
      return {
        provider: "fcm" as const,
        enabled: true,
        configured: true,
        dedupeWindowMinutes: 30,
        tokens: { total: 0, active: 0, revoked: 0 },
      };
    },
  };
  attachNotificationService(svc as unknown as NotificationService);
  return { calls, svc: svc as unknown as NotificationService };
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

describe("event-gate FCM producers", () => {
  beforeEach(() => {
    resetRiskCache();
    attachRiskRedis(null);
    attachNotificationService(null);
    resetMassiveCache();
    clearMassiveTestKey();
  });

  afterEach(() => {
    resetRiskCache();
    attachRiskRedis(null);
    attachNotificationService(null);
    resetMassiveCache();
    clearMassiveTestKey();
    vi.unstubAllGlobals();
  });

  it("OFF→ON and ON→OFF each send risk_flip once; unchanged riskOn does not", async () => {
    const { calls } = countingService();
    seedPersistedRiskOn(false);
    await applyResolvedRisk(onSnap());
    await applyResolvedRisk(onSnap());
    await applyResolvedRisk(offSnap());
    await applyResolvedRisk(offSnap());
    expect(calls).toHaveLength(2);
    expect(calls[0].principal).toBe(EVENT_GATE_ALERT_PRINCIPAL);
    expect(calls[0].payload.eventType).toBe("risk_flip");
    expect(calls[0].payload.title).toBe("Event Gate: RISK ON");
    expect(calls[0].payload.body).toMatch(/SPY, ACWI, HYG above 200dma/);
    expect(calls[0].payload.body).toMatch(/dollar veto cleared/);
    expect(calls[0].payload.deepLinkRoute).toBe("/status");
    expect(calls[0].payload.dedupeKey).toMatch(/^risk_flip:on:/);
    expect(calls[1].payload.eventType).toBe("risk_flip");
    expect(calls[1].payload.title).toBe("Event Gate: RISK OFF");
    expect(calls[1].payload.body).toMatch(/HYG below 200dma/);
    expect(calls[1].payload.dedupeKey).toMatch(/^risk_flip:off:/);
    expect(JSON.stringify(calls)).not.toMatch(/position|pnl|secret|password|BEGIN PRIVATE/i);
  });

  it("restart/baseline does not spam a flip when persisted riskOn matches", async () => {
    const redis = memoryRedis();
    attachRiskRedis(redis.client);
    const { calls } = countingService();
    await applyResolvedRisk(onSnap());
    expect(calls).toHaveLength(0);
    expect(redis.store.get(REDIS_KEYS.riskOn)).toBe("1");
    expect(getLastKnownRiskOn()).toBe(true);

    resetRiskCache();
    resetEventGateAlertState();
    attachRiskRedis(redis.client);
    const { calls: afterRestart } = countingService();
    await applyResolvedRisk(onSnap());
    expect(afterRestart).toHaveLength(0);
    expect(getLastKnownRiskOn()).toBe(true);

    await applyResolvedRisk(offSnap());
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0].payload.eventType).toBe("risk_flip");
    expect(afterRestart[0].payload.title).toBe("Event Gate: RISK OFF");
    expect(redis.store.get(REDIS_KEYS.riskOn)).toBe("0");
  });

  it("first boot without persisted state sets baseline without notifying", async () => {
    const { calls } = countingService();
    await applyResolvedRisk(offSnap());
    expect(calls).toHaveLength(0);
    expect(getLastKnownRiskOn()).toBe(false);
    await applyResolvedRisk(onSnap());
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.title).toBe("Event Gate: RISK ON");
  });

  it("ensureRisk cache refresh does not re-send when riskOn is unchanged", async () => {
    const { calls } = countingService();
    seedPersistedRiskOn(false);
    setMassiveTestKey();
    stubMarketFetch({
      aggs: {
        SPY: barsCloses(220, 100),
        ACWI: barsCloses(220, 100),
        HYG: barsCloses(220, 100),
        UUP: barsCloses(220, 100),
      },
    });
    const first = await ensureRisk();
    expect(first.riskOn).toBe(true);
    expect(calls.filter((c) => c.payload.eventType === "risk_flip")).toHaveLength(1);
    const again = await ensureRisk();
    expect(again.riskOn).toBe(true);
    expect(calls.filter((c) => c.payload.eventType === "risk_flip")).toHaveLength(1);
    const refreshed = await ensureRisk(Date.now() + RISK_CACHE_MS + 1);
    expect(refreshed.riskOn).toBe(true);
    expect(calls.filter((c) => c.payload.eventType === "risk_flip")).toHaveLength(1);
  });

  it("quotes hard failure that forces riskOffFallback sends service_fault once", async () => {
    const { calls } = countingService();
    seedPersistedRiskOn(true);
    noteServiceUp("quotes");
    const snap = await ensureRisk();
    expect(snap.riskOn).toBe(false);
    const faults = calls.filter((c) => c.payload.eventType === "service_fault");
    const flips = calls.filter((c) => c.payload.eventType === "risk_flip");
    expect(faults).toHaveLength(1);
    expect(faults[0].payload.title).toBe("Event Gate: service fault");
    expect(faults[0].payload.body).toBe("quotes unavailable");
    expect(faults[0].payload.dedupeKey).toBe("service_fault:quotes");
    expect(faults[0].payload.deepLinkRoute).toBe("/status");
    expect(flips).toHaveLength(1);
    expect(flips[0].payload.title).toBe("Event Gate: RISK OFF");
    await applyResolvedRisk(riskFromFeatures({
      spy: null,
      acwi: null,
      hyg: null,
      uup20dPct: null,
    }), { hardFailure: true });
    expect(calls.filter((c) => c.payload.eventType === "service_fault")).toHaveLength(1);
  });

  it("service_fault fires on postgres/redis up→down and dedupes until recovered", async () => {
    const { calls } = countingService();
    expect(await noteServiceDown("postgres")).toBeNull();
    expect(await noteServiceDown("redis")).toBeNull();
    noteServiceUp("postgres");
    noteServiceUp("redis");
    const pg = await noteServiceDown("postgres");
    const rd = await noteServiceDown("redis");
    expect(pg?.outcome).toBe("delivered");
    expect(rd?.outcome).toBe("delivered");
    expect(await noteServiceDown("postgres")).toBeNull();
    expect(await noteServiceDown("redis")).toBeNull();
    expect(calls.map((c) => c.payload.dedupeKey).sort()).toEqual([
      "service_fault:postgres",
      "service_fault:redis",
    ]);
    expect(calls.every((c) => c.principal === EVENT_GATE_ALERT_PRINCIPAL)).toBe(true);
    expect(calls.every((c) => c.payload.eventType === "service_fault")).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(/postgres:\/\/|redis:\/\/|password|credential/i);
  });

  it("missing FCM / throwing send never crashes a risk flip", async () => {
    attachNotificationService(null);
    seedPersistedRiskOn(false);
    await expect(applyResolvedRisk(onSnap())).resolves.toBeUndefined();

    attachNotificationService({
      sendAlert: async () => {
        throw new Error("provider boom");
      },
    } as unknown as NotificationService);
    seedPersistedRiskOn(true);
    await expect(applyResolvedRisk(offSnap())).resolves.toBeUndefined();
  });

  it("risk flip copy stays within payload limits and names only the gate checks", () => {
    const on = onSnap();
    const off = offSnap();
    expect(riskFlipTitle(true)).toBe("Event Gate: RISK ON");
    expect(riskFlipTitle(false)).toBe("Event Gate: RISK OFF");
    expect(riskFlipBody(on).length).toBeLessThanOrEqual(500);
    expect(riskFlipBody(off).length).toBeLessThanOrEqual(500);
    expect(riskFlipDedupeKey(on).length).toBeLessThanOrEqual(180);
    expect(riskFlipBody(on)).not.toMatch(/position|order|P\/L/i);
  });

  it("pre_arm fires once when the clock enters PRE-ARM; staying there does not spam", async () => {
    const { calls } = countingService();
    const events = seedEvents();
    const pre = computeClock(new Date("2026-09-04T12:20:00Z"), events);
    expect(pre.mode).toBe("PRE-ARM");
    expect(pre.focusEvent?.type).toBe("NFP");
    await considerClockAlerts(pre, emptyFreeze());
    await considerClockAlerts(pre, { freezeTimestamp: "2026-09-04T11:00:00.000Z" });
    expect(calls.filter((c) => c.payload.eventType === "pre_arm")).toHaveLength(1);
    expect(calls[0].payload.title).toBe("Event Gate: PRE-ARM");
    expect(calls[0].payload.body).toMatch(/NFP/);
    expect(calls[0].payload.dedupeKey).toBe("pre_arm:nfp-2026-09-04");
  });

  it("freeze_missing fires in the 2h lead or PRE-ARM when the freeze card is empty, once per event", async () => {
    const { calls } = countingService();
    const events = seedEvents();
    const lead = computeClock(new Date("2026-09-04T11:00:00Z"), events);
    expect(lead.countdownMs).toBeGreaterThan(0);
    expect(lead.countdownMs).toBeLessThanOrEqual(FREEZE_MISSING_LEAD_MS);
    expect(lead.mode).toBe("idle");
    await considerClockAlerts(lead, emptyFreeze());
    await considerClockAlerts(lead, emptyFreeze());
    expect(calls.filter((c) => c.payload.eventType === "freeze_missing")).toHaveLength(1);
    expect(calls[0].payload.body).toMatch(/NFP/);
    expect(calls[0].payload.dedupeKey).toBe("freeze_missing:nfp-2026-09-04");

    resetEventGateAlertState();
    const { calls: filled } = countingService();
    await considerClockAlerts(lead, { freezeTimestamp: "2026-09-04T10:00:00.000Z" });
    expect(filled).toHaveLength(0);
  });

  it("day fill, flatten, loss cap, and veto_confirm send typed payloads", async () => {
    const { calls } = countingService();
    await notifyDayFill("MES=F");
    await notifyDayFlatten("session");
    await notifyDayLossCap();
    await notifyVetoConfirm("flatten");
    await notifyVetoConfirm("gate_off");
    expect(calls.map((c) => c.payload.eventType)).toEqual([
      "day_fill",
      "day_flatten",
      "day_loss_cap",
      "veto_confirm",
      "veto_confirm",
    ]);
    expect(calls[0].payload.body).toMatch(/MES/);
    expect(calls[3].payload.body).toMatch(/Flatten confirmed/);
    expect(calls[4].payload.body).toMatch(/GATE OFF/);
    expect(JSON.stringify(calls)).not.toMatch(/avgPrice|stopPrice|password/i);
  });

  it("gate tick session flatten and daily loss produce day_flatten / day_loss_cap", async () => {
    const { calls } = countingService();
    await considerGateTickAlerts({
      actions: [{ kind: "flatten", reason: "session flatten 15:45 ET" }],
    });
    await considerGateTickAlerts({
      actions: [{ kind: "log", message: "flatten (daily loss -520 (limit 500)): nothing open" }],
    });
    expect(calls.map((c) => c.payload.eventType)).toEqual(["day_flatten", "day_loss_cap"]);
  });

  it("overlay rotation, credit put open/stop/risk-on flatten send once", async () => {
    const { calls } = countingService();
    await notifyOverlayRotation("XLP", "GLD");
    await notifyCreditPutOpened("HYG");
    await notifyCreditPutStopped("HYG");
    await notifyCreditPutRiskOnFlatten();
    expect(calls.map((c) => c.payload.eventType)).toEqual([
      "overlay_rotation",
      "credit_put_opened",
      "credit_put_stopped",
      "credit_put_risk_on_flatten",
    ]);
    expect(calls[0].payload.body).toMatch(/XLP → GLD/);
    expect(calls[1].payload.body).toMatch(/HYG/);
    expect(calls[2].payload.body).toMatch(/50% debit stop/);
    expect(calls[3].payload.body).toMatch(/RISK ON/);
  });

  it("oi_skip_streak fires once at N skips in the window and resets on RISK ON / put open", async () => {
    const { calls } = countingService();
    const t0 = Date.now();
    for (let i = 0; i < OI_SKIP_STREAK_N - 1; i++) {
      expect(await noteCreditLegOiSkip(t0 + i * 60_000)).toBeNull();
    }
    expect(calls).toHaveLength(0);
    await noteCreditLegOiSkip(t0 + (OI_SKIP_STREAK_N - 1) * 60_000);
    expect(calls.map((c) => c.payload.eventType)).toEqual(["oi_skip_streak"]);
    expect(calls[0].payload.body).toMatch(/blocked on OI/);
    expect(await noteCreditLegOiSkip(t0 + OI_SKIP_STREAK_N * 60_000)).toBeNull();
    expect(calls).toHaveLength(1);
    resetOiSkipStreak();
    for (let i = 0; i < OI_SKIP_STREAK_N; i++) {
      await noteCreditLegOiSkip(t0 + 40 * 60_000 + i * 1_000);
    }
    expect(calls.filter((c) => c.payload.eventType === "oi_skip_streak")).toHaveLength(2);
  });

  it("etrade_renew_failed and sleeve_loss_warn fire with per-day sleeve dedupe", async () => {
    const { calls } = countingService();
    await notifyEtradeRenewFailed();
    expect(calls[0].payload.eventType).toBe("etrade_renew_failed");
    expect(calls[0].payload.body).toMatch(/renew failed/);

    const sleeves = defaultSleeves();
    const books = {
      day: book(-100, 0),
      momentum: book(-850, -850),
      options: book(0, 0),
      ownership: book(0, 0),
      riskoff: book(0, 0),
    } as Record<SleeveId, SleeveBook>;
    await considerSleeveLossWarn(sleeves, books, new Date("2026-09-04T18:00:00Z"));
    await considerSleeveLossWarn(sleeves, books, new Date("2026-09-04T18:05:00Z"));
    const warns = calls.filter((c) => c.payload.eventType === "sleeve_loss_warn");
    expect(warns).toHaveLength(1);
    expect(warns[0].payload.body).toMatch(/momentum/i);
    expect(warns[0].payload.dedupeKey).toBe("sleeve_loss_warn:momentum:2026-09-04");
  });

  it("POST flatten and GATE OFF send veto_confirm (and manual day_flatten)", async () => {
    const { calls, svc } = countingService();
    const events = seedEvents();
    const broker = new MockBroker();
    const engine = new GateEngine(broker, () => new Date(), () => events, {
      enabled: true,
      dailyLossUsd: 500,
    });
    const app = buildApp({
      cfg: {
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
      } as AppConfig,
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
      notifications: svc,
    });
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no listen address");
    const url = `http://127.0.0.1:${addr.port}`;
    try {
      const flatten = await fetch(`${url}/api/flatten`, { method: "POST" });
      expect(flatten.status).toBe(200);
      const off = await fetch(`${url}/api/gate/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(off.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
    expect(calls.some((c) => c.payload.eventType === "day_flatten")).toBe(true);
    expect(calls.filter((c) => c.payload.eventType === "veto_confirm").map((c) => c.payload.body)).toEqual([
      "Flatten confirmed.",
      "GATE OFF confirmed.",
    ]);
  });
});

function book(daily: number, total: number): SleeveBook {
  return {
    equityUsd: 100_000 + total,
    realizedPnlUsd: total,
    unrealizedPnlUsd: 0,
    pnlUsd: total,
    totalPnlUsd: total,
    dailyPnlUsd: daily,
  };
}
