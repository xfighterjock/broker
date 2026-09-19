import { sameEtDay } from "./dayMomentum";
import { freezeCardEmpty, isPrintEvent } from "./eventGateAlerts";
import type { CalendarEvent, FreezeCard } from "../../shared/types";

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
 * Print used to arm knowledge_time on this America/New_York day.
 * FOMC: STATEMENT time when both STATEMENT and PC exist; otherwise the FOMC row.
 * NFP/CPI: the print time.
 */
export function knowledgeTimeAnchorEvent(
  now: Date,
  events: CalendarEvent[],
): CalendarEvent | null {
  const todays = events
    .filter((ev) => isPrintEvent(ev) && Number.isFinite(Date.parse(ev.timeUtc)))
    .filter((ev) => sameEtDay(now, new Date(ev.timeUtc)))
    .slice()
    .sort((a, b) => Date.parse(a.timeUtc) - Date.parse(b.timeUtc));
  if (todays.length === 0) return null;
  const fomc = todays.filter((ev) => ev.type.toUpperCase().includes("FOMC"));
  if (fomc.length > 0) {
    return fomc.find((ev) => ev.type.toUpperCase().includes("STATEMENT")) ?? fomc[0];
  }
  return todays[0];
}

export function shouldAutoStampKnowledgeTime(input: {
  now: Date;
  events: CalendarEvent[];
  freeze: Pick<FreezeCard, "freezeTimestamp">;
  knowledgeTime: string | null | undefined;
}): { stamp: boolean; reason: string; event: CalendarEvent | null } {
  const event = knowledgeTimeAnchorEvent(input.now, input.events);
  if (!event) return { stamp: false, reason: "no print event today", event: null };
  if (freezeCardEmpty(input.freeze)) return { stamp: false, reason: "no freeze", event };
  if (knowledgeTimeAlreadySetForEtDay(input.now, input.knowledgeTime)) {
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
