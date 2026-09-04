import { etParts, pad2 } from "../../shared/clock";
import { RISKOFF_CREDIT_LEG_SYMBOLS } from "../../shared/constants";
import type {
  CalendarEvent,
  ClockSnapshot,
  FreezeCard,
  SleeveBook,
  SleeveCard,
  SleeveId,
} from "../../shared/types";
import {
  createEventGateAlert,
  sendEventGateAlert,
  type EventGateAlertType,
  type SendResult,
} from "./notifications";

/** Matches iOS `x-remote-user` registration. */
export const EVENT_GATE_ALERT_PRINCIPAL = "event-gate";

export const SERVICE_FAULT_CLASSES = ["postgres", "redis", "quotes"] as const;
export type ServiceFaultClass = (typeof SERVICE_FAULT_CLASSES)[number];

export const OI_SKIP_STREAK_N = 6;
export const OI_SKIP_WINDOW_MS = 30 * 60 * 1000;
export const SLEEVE_LOSS_WARN_FRAC = 0.8;
export const FREEZE_MISSING_LEAD_MS = 2 * 60 * 60 * 1000;

const CREDIT_LEG = new Set<string>(RISKOFF_CREDIT_LEG_SYMBOLS);

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

let lastClockMode: ClockSnapshot["mode"] | null = null;
const sentPreArm = new Set<string>();
const sentFreezeMissing = new Set<string>();
const oiSkipAt: number[] = [];
let oiSkipNotified = false;
const sleeveWarnSent = new Set<string>();

export function resetEventGateAlertState(): void {
  lastUp.postgres = null;
  lastUp.redis = null;
  lastUp.quotes = null;
  lastClockMode = null;
  sentPreArm.clear();
  sentFreezeMissing.clear();
  oiSkipAt.length = 0;
  oiSkipNotified = false;
  sleeveWarnSent.clear();
}

export function nyDateKey(now = new Date()): string {
  const p = etParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function isPrintEvent(ev: CalendarEvent): boolean {
  const t = ev.type.toUpperCase();
  return t === "NFP" || t === "CPI" || t.includes("FOMC");
}

export function isCreditLegSymbol(symbol: string): boolean {
  return CREDIT_LEG.has(symbol.trim().toUpperCase());
}

export function freezeCardEmpty(freeze: Pick<FreezeCard, "freezeTimestamp">): boolean {
  return !freeze.freezeTimestamp;
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

export async function safeSendEventGateAlert(input: {
  title: string;
  body: string;
  eventType: EventGateAlertType;
  dedupeKey: string;
  deepLinkRoute?: string;
  occurredAt?: string;
}): Promise<SendResult> {
  try {
    return await sendEventGateAlert(
      EVENT_GATE_ALERT_PRINCIPAL,
      createEventGateAlert({
        title: input.title,
        body: input.body,
        eventType: input.eventType,
        occurredAt: input.occurredAt ?? new Date().toISOString(),
        dedupeKey: input.dedupeKey,
        deepLinkRoute: input.deepLinkRoute ?? "/status",
      }),
    );
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
    dedupeKey: `service_fault:${subsystem}`,
  });
}

export async function notifyAuthNeeded(): Promise<SendResult> {
  return safeSendEventGateAlert({
    title: "Event Gate: E*TRADE PIN needed",
    body: "Authorize E*TRADE from Event Gate. Paper trading only.",
    eventType: "auth_needed",
    dedupeKey: "auth_needed:etrade:needs_pin",
  });
}

export async function considerClockAlerts(
  clock: ClockSnapshot,
  freeze: Pick<FreezeCard, "freezeTimestamp">,
): Promise<void> {
  try {
    const focus = clock.focusEvent ?? clock.activeEvent;
    if (clock.mode === "PRE-ARM" && lastClockMode !== "PRE-ARM" && focus && isPrintEvent(focus)) {
      if (!sentPreArm.has(focus.id)) {
        sentPreArm.add(focus.id);
        await safeSendEventGateAlert({
          title: "Event Gate: PRE-ARM",
          body: `${focus.type.replace(/_/g, " ")} T−15. Day sleeve only.`,
          eventType: "pre_arm",
          dedupeKey: `pre_arm:${focus.id}`,
        });
      }
    }
    lastClockMode = clock.mode;

    if (!focus || !isPrintEvent(focus) || !freezeCardEmpty(freeze)) return;
    const lead = clock.countdownMs;
    const inLead =
      clock.inPreArm || (lead !== null && lead > 0 && lead <= FREEZE_MISSING_LEAD_MS);
    if (!inLead || sentFreezeMissing.has(focus.id)) return;
    sentFreezeMissing.add(focus.id);
    await safeSendEventGateAlert({
      title: "Event Gate: freeze card missing",
      body: `No freeze card for ${focus.type.replace(/_/g, " ")}.`,
      eventType: "freeze_missing",
      dedupeKey: `freeze_missing:${focus.id}`,
    });
  } catch (err) {
    console.warn("[EventGate] clock alert hook failed", err instanceof Error ? err.message : err);
  }
}

export async function notifyDayFill(symbol: string): Promise<SendResult> {
  const name = symbol.trim().toUpperCase() || "day";
  return safeSendEventGateAlert({
    title: "Event Gate: day fill",
    body: `Day sleeve paper fill opened (${name}).`,
    eventType: "day_fill",
    dedupeKey: `day_fill:${name}:${nyDateKey()}`,
  });
}

export async function notifyDayFlatten(kind: "session" | "manual"): Promise<SendResult> {
  return safeSendEventGateAlert({
    title: "Event Gate: day flatten",
    body: kind === "manual" ? "Day sleeve flattened (manual)." : "Day sleeve flattened (session).",
    eventType: "day_flatten",
    dedupeKey: `day_flatten:${kind}:${nyDateKey()}`,
  });
}

export async function notifyDayLossCap(): Promise<SendResult> {
  return safeSendEventGateAlert({
    title: "Event Gate: day loss cap",
    body: "Day sleeve hit its loss cap.",
    eventType: "day_loss_cap",
    dedupeKey: `day_loss_cap:${nyDateKey()}`,
  });
}

export async function notifyVetoConfirm(kind: "flatten" | "gate_off"): Promise<SendResult> {
  return safeSendEventGateAlert({
    title: "Event Gate: veto confirmed",
    body: kind === "gate_off" ? "GATE OFF confirmed." : "Flatten confirmed.",
    eventType: "veto_confirm",
    dedupeKey: `veto_confirm:${kind}:${nyDateKey()}`,
  });
}

export async function considerGateTickAlerts(result: {
  actions: Array<{ kind: string; reason?: string; message?: string }>;
}): Promise<void> {
  try {
    let loss = false;
    let session = false;
    for (const a of result.actions) {
      const text = `${a.reason ?? ""} ${a.message ?? ""}`;
      if (/daily loss/i.test(text)) loss = true;
      if (/session flatten/i.test(text)) session = true;
    }
    if (loss) await notifyDayLossCap();
    if (session) await notifyDayFlatten("session");
  } catch (err) {
    console.warn("[EventGate] gate alert hook failed", err instanceof Error ? err.message : err);
  }
}

export async function notifyOverlayRotation(fromSymbol: string, toSymbol: string): Promise<SendResult> {
  const from = fromSymbol.trim().toUpperCase() || "?";
  const to = toSymbol.trim().toUpperCase() || "?";
  return safeSendEventGateAlert({
    title: "Event Gate: overlay rotation",
    body: `Risk-off overlay ${from} → ${to}.`,
    eventType: "overlay_rotation",
    dedupeKey: `overlay_rotation:${from}:${to}:${nyDateKey()}`,
  });
}

export async function notifyCreditPutOpened(symbol: string): Promise<SendResult> {
  resetOiSkipStreak();
  const name = symbol.trim().toUpperCase();
  return safeSendEventGateAlert({
    title: "Event Gate: credit put opened",
    body: `Credit-leg put opened on ${name}.`,
    eventType: "credit_put_opened",
    dedupeKey: `credit_put_opened:${name}:${nyDateKey()}`,
  });
}

export async function notifyCreditPutStopped(symbol: string): Promise<SendResult> {
  const name = symbol.trim().toUpperCase();
  return safeSendEventGateAlert({
    title: "Event Gate: credit put stopped",
    body: `Credit-leg put 50% debit stop on ${name}.`,
    eventType: "credit_put_stopped",
    dedupeKey: `credit_put_stopped:${name}:${nyDateKey()}`,
  });
}

export async function notifyCreditPutRiskOnFlatten(): Promise<SendResult> {
  resetOiSkipStreak();
  return safeSendEventGateAlert({
    title: "Event Gate: credit puts flattened",
    body: "RISK ON flattened credit-leg puts.",
    eventType: "credit_put_risk_on_flatten",
    dedupeKey: `credit_put_risk_on_flatten:${nyDateKey()}`,
  });
}

export function resetOiSkipStreak(): void {
  oiSkipAt.length = 0;
  oiSkipNotified = false;
}

/** Count an HYG/LQD/JNK OI/liquidity skip. Sends once at N in the window. */
export async function noteCreditLegOiSkip(now = Date.now()): Promise<SendResult | null> {
  try {
    oiSkipAt.push(now);
    const floor = now - OI_SKIP_WINDOW_MS;
    while (oiSkipAt.length && oiSkipAt[0] < floor) oiSkipAt.shift();
    if (oiSkipAt.length < OI_SKIP_STREAK_N || oiSkipNotified) return null;
    oiSkipNotified = true;
    return safeSendEventGateAlert({
      title: "Event Gate: credit puts blocked",
      body: "Credit puts blocked on OI.",
      eventType: "oi_skip_streak",
      dedupeKey: `oi_skip_streak:${nyDateKey()}`,
    });
  } catch {
    return null;
  }
}

export async function notifyEtradeRenewFailed(): Promise<SendResult> {
  return safeSendEventGateAlert({
    title: "Event Gate: E*TRADE renew failed",
    body: "E*TRADE access-token renew failed.",
    eventType: "etrade_renew_failed",
    dedupeKey: "etrade_renew_failed",
  });
}

export async function considerSleeveLossWarn(
  sleeves: Record<SleeveId, SleeveCard>,
  books: Record<SleeveId, SleeveBook>,
  now = new Date(),
): Promise<void> {
  try {
    const ymd = nyDateKey(now);
    for (const id of Object.keys(sleeves) as SleeveId[]) {
      const sleeve = sleeves[id];
      const book = books[id];
      if (!sleeve || !book) continue;
      const cap = sleeve.lossCapUsd;
      if (!(cap > 0)) continue;
      const pnl = book.totalPnlUsd;
      if (id === "day" && pnl <= -cap) await notifyDayLossCap();
      if (pnl > -cap * SLEEVE_LOSS_WARN_FRAC) continue;
      const key = `${id}:${ymd}`;
      if (sleeveWarnSent.has(key)) continue;
      sleeveWarnSent.add(key);
      await safeSendEventGateAlert({
        title: "Event Gate: sleeve near loss cap",
        body: `${sleeve.name} is near its loss cap.`,
        eventType: "sleeve_loss_warn",
        dedupeKey: `sleeve_loss_warn:${id}:${ymd}`,
      });
    }
  } catch (err) {
    console.warn("[EventGate] sleeve loss warn failed", err instanceof Error ? err.message : err);
  }
}
