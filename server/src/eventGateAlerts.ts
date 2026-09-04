import {
  createEventGateAlert,
  sendEventGateAlert,
  type SendResult,
} from "./notifications";

/** Matches iOS `x-remote-user` registration. */
export const EVENT_GATE_ALERT_PRINCIPAL = "event-gate";

export const SERVICE_FAULT_CLASSES = ["postgres", "redis", "quotes"] as const;
export type ServiceFaultClass = (typeof SERVICE_FAULT_CLASSES)[number];

/** Minimal risk snapshot for flip copy. Keep this file free of risk.ts imports. */
export type RiskAlertSnap = {
  riskOn: boolean;
  checks: {
    spyAbove200: boolean;
    acwiAbove200: boolean;
    hygAbove200: boolean;
    uup20dPct: number | null;
    dollarVeto: boolean;
  };
};

const lastUp: Record<ServiceFaultClass, boolean | null> = {
  postgres: null,
  redis: null,
  quotes: null,
};

export function resetEventGateAlertState(): void {
  lastUp.postgres = null;
  lastUp.redis = null;
  lastUp.quotes = null;
}

export function riskFlipTitle(riskOn: boolean): string {
  return riskOn ? "Event Gate: RISK ON" : "Event Gate: RISK OFF";
}

export function riskFlipBody(snap: RiskAlertSnap): string {
  const c = snap.checks;
  if (snap.riskOn) {
    const uup =
      c.uup20dPct === null || !Number.isFinite(c.uup20dPct)
        ? "UUP 20d n/a"
        : `UUP 20d ${(c.uup20dPct * 100).toFixed(1)}%`;
    return `SPY, ACWI, HYG above 200dma; ${uup}; dollar veto cleared`;
  }
  const failed: string[] = [];
  if (!c.spyAbove200) failed.push("SPY below 200dma");
  if (!c.acwiAbove200) failed.push("ACWI below 200dma");
  if (!c.hygAbove200) failed.push("HYG below 200dma");
  if (c.dollarVeto) {
    failed.push(
      c.uup20dPct === null || !Number.isFinite(c.uup20dPct)
        ? "dollar veto (UUP 20d missing)"
        : `dollar veto (UUP 20d ${(c.uup20dPct * 100).toFixed(1)}%)`,
    );
  }
  return failed.join("; ") || "risk-off";
}

export function riskCheckSignature(snap: RiskAlertSnap): string {
  const c = snap.checks;
  return [
    c.spyAbove200 ? "s1" : "s0",
    c.acwiAbove200 ? "a1" : "a0",
    c.hygAbove200 ? "h1" : "h0",
    c.dollarVeto ? "d1" : "d0",
  ].join("");
}

/** Direction + check signature + UTC hour so a true flip notifies; cache refresh is skipped by the caller. */
export function riskFlipDedupeKey(snap: RiskAlertSnap, now = new Date()): string {
  const hour = now.toISOString().slice(0, 13);
  return `risk_flip:${snap.riskOn ? "on" : "off"}:${riskCheckSignature(snap)}:${hour}`;
}

export async function safeSendEventGateAlert(
  payload: Parameters<typeof createEventGateAlert>[0],
): Promise<SendResult> {
  try {
    return await sendEventGateAlert(EVENT_GATE_ALERT_PRINCIPAL, createEventGateAlert(payload));
  } catch (err) {
    console.warn(
      "[EventGate] sendEventGateAlert failed",
      err instanceof Error ? err.message : err,
    );
    return {
      outcome: "error",
      provider: "fcm",
      attempted: 0,
      delivered: 0,
      failed: 0,
      skipped: 0,
      reason: "send hook threw",
    };
  }
}

export async function notifyRiskFlip(snap: RiskAlertSnap, now = new Date()): Promise<SendResult> {
  return safeSendEventGateAlert({
    title: riskFlipTitle(snap.riskOn),
    body: riskFlipBody(snap),
    eventType: "risk_flip",
    occurredAt: now.toISOString(),
    dedupeKey: riskFlipDedupeKey(snap, now),
    deepLinkRoute: "/status",
  });
}

export function noteServiceUp(subsystem: ServiceFaultClass): void {
  lastUp[subsystem] = true;
}

/** Notify once on up → down. First-seen down (startup / restart baseline) is silent. */
export async function noteServiceDown(subsystem: ServiceFaultClass): Promise<SendResult | null> {
  const was = lastUp[subsystem];
  lastUp[subsystem] = false;
  if (was !== true) return null;
  return safeSendEventGateAlert({
    title: "Event Gate: service fault",
    body: `${subsystem} unavailable`,
    eventType: "service_fault",
    occurredAt: new Date().toISOString(),
    dedupeKey: `service_fault:${subsystem}`,
    deepLinkRoute: "/status",
  });
}
