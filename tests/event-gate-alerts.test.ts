import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REDIS_KEYS } from "../shared/constants";
import {
  EVENT_GATE_ALERT_PRINCIPAL,
  noteServiceDown,
  noteServiceUp,
  resetEventGateAlertState,
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
  };
  attachNotificationService(svc as unknown as NotificationService);
  return calls;
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
    const calls = countingService();
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
    const calls = countingService();
    await applyResolvedRisk(onSnap());
    expect(calls).toHaveLength(0);
    expect(redis.store.get(REDIS_KEYS.riskOn)).toBe("1");
    expect(getLastKnownRiskOn()).toBe(true);

    resetRiskCache();
    resetEventGateAlertState();
    attachRiskRedis(redis.client);
    const afterRestart = countingService();
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
    const calls = countingService();
    await applyResolvedRisk(offSnap());
    expect(calls).toHaveLength(0);
    expect(getLastKnownRiskOn()).toBe(false);
    await applyResolvedRisk(onSnap());
    expect(calls).toHaveLength(1);
    expect(calls[0].payload.title).toBe("Event Gate: RISK ON");
  });

  it("ensureRisk cache refresh does not re-send when riskOn is unchanged", async () => {
    const calls = countingService();
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
    const calls = countingService();
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
    const calls = countingService();
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
});
