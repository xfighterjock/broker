import { knowledgeTimeAnchorEvent, sameEtDay } from "../../shared/clock";
import type { CalendarEvent } from "../../shared/types";

export { knowledgeTimeAnchorEvent };

export type KnowledgeTimeStampSource = "manual" | "ops" | "auto";

/** Same-ET-day stamp already present. Do not write a second stamp that day. */
export function knowledgeTimeAlreadySetForEtDay(
  now: Date,
  knowledgeTime: string | null | undefined,
): boolean {
  if (!knowledgeTime) return false;
  const kt = Date.parse(knowledgeTime);
  if (!Number.isFinite(kt)) return false;
  return sameEtDay(now, new Date(kt));
}

/**
 * A same-ET-day stamp at or after the anchor print. A pre-print stamp, or a
 * stamp on a day with no NFP/CPI/FOMC row, does not block a later stamp.
 */
export function knowledgeTimeStampIsFinal(
  now: Date,
  knowledgeTime: string | null | undefined,
  events: CalendarEvent[],
): boolean {
  if (!knowledgeTimeAlreadySetForEtDay(now, knowledgeTime) || !knowledgeTime) return false;
  const anchor = knowledgeTimeAnchorEvent(now, events);
  if (!anchor) return false;
  const kt = Date.parse(knowledgeTime);
  const t = Date.parse(anchor.timeUtc);
  return Number.isFinite(kt) && Number.isFinite(t) && kt >= t;
}

/**
 * Manual/ops POST may record a stamp only on a print day at or after the anchor.
 * A non-print day (claims, blank day) or a pre-print stamp is refused so it
 * cannot arm Stage-3 or block the auto-stamp.
 */
export function knowledgeTimeManualAllowed(
  now: Date,
  events: CalendarEvent[],
): { ok: boolean; reason: string } {
  const event = knowledgeTimeAnchorEvent(now, events);
  if (!event) return { ok: false, reason: "knowledge_time not on a print day" };
  const t = Date.parse(event.timeUtc);
  if (!Number.isFinite(t) || now.getTime() < t) {
    return { ok: false, reason: "knowledge_time before print" };
  }
  return { ok: true, reason: "ok" };
}

/**
 * Stamp once the anchor print time has passed and this ET day has no
 * at-or-after-anchor stamp. A freeze card is not required. Jobless claims
 * and other non-print rows do not qualify. A leftover pre-print stamp does
 * not count as already stamped.
 */
export function shouldAutoStampKnowledgeTime(input: {
  now: Date;
  events: CalendarEvent[];
  knowledgeTime: string | null | undefined;
}): { stamp: boolean; reason: string; event: CalendarEvent | null } {
  const event = knowledgeTimeAnchorEvent(input.now, input.events);
  if (!event) return { stamp: false, reason: "no print event today", event: null };
  if (knowledgeTimeStampIsFinal(input.now, input.knowledgeTime, input.events)) {
    return { stamp: false, reason: "already stamped", event };
  }
  const t = Date.parse(event.timeUtc);
  if (!Number.isFinite(t) || input.now.getTime() < t) {
    return { stamp: false, reason: "before print", event };
  }
  return { stamp: true, reason: "auto", event };
}

export function knowledgeTimeLogLine(source: KnowledgeTimeStampSource, iso: string): string {
  if (source === "auto") return `knowledge_time auto-stamped ${iso}`;
  if (source === "ops") return `knowledge_time ops-stamped ${iso}`;
  return `knowledge_time manual ${iso}`;
}

export function knowledgeTimeRefusedLine(source: KnowledgeTimeStampSource, reason: string): string {
  return `knowledge_time refused (${source}): ${reason}`;
}
