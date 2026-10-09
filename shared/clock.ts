import {
  BAND_MS,
  FLATTEN_WINDOW_MS,
  GATED_ROOTS_LONGEST,
  PRE_ARM_MS,
  TZ,
} from "./constants";
import type { CalendarEvent, ClockSnapshot, GateMode } from "./types";

export function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function part(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  weekday: "short",
  timeZoneName: "short",
});

export function etParts(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: string;
  tzName: string;
} {
  const parts = ET_PARTS.formatToParts(date);
  let hour = Number(part(parts, "hour"));
  if (hour === 24) hour = 0;
  return {
    year: Number(part(parts, "year")),
    month: Number(part(parts, "month")),
    day: Number(part(parts, "day")),
    hour,
    minute: Number(part(parts, "minute")),
    second: Number(part(parts, "second")),
    weekday: part(parts, "weekday"),
    tzName: part(parts, "timeZoneName"),
  };
}

export function formatEt(date: Date): string {
  const p = etParts(date);
  return `${p.weekday} ${p.year}-${pad2(p.month)}-${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)} ${p.tzName}`;
}

export function formatEtShort(date: Date): string {
  const p = etParts(date);
  return `${pad2(p.month)}/${pad2(p.day)} ${pad2(p.hour)}:${pad2(p.minute)} ${p.tzName}`;
}

/** Offset of tz wall-clock vs UTC at `date` (ms). wallAsUtc - actualUtc. */
export function tzOffsetMs(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  let hour = Number(part(parts, "hour"));
  if (hour === 24) hour = 0;
  const asUtc = Date.UTC(
    Number(part(parts, "year")),
    Number(part(parts, "month")) - 1,
    Number(part(parts, "day")),
    hour,
    Number(part(parts, "minute")),
    Number(part(parts, "second")),
  );
  return asUtc - date.getTime();
}

/** Interpret a wall time in `timeZone` as a UTC Date. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second = 0,
  timeZone = TZ,
): Date {
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let utc = wallAsUtc - tzOffsetMs(new Date(wallAsUtc), timeZone);
  utc = wallAsUtc - tzOffsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

export function flattenEtFor(ev: CalendarEvent): string {
  if (ev.type.toUpperCase().includes("FOMC")) return "15:30";
  return ev.flattenEt || "15:45";
}

export function parseHmm(hmm: string): { hour: number; minute: number } {
  const [h, m] = hmm.split(":").map((x) => Number(x));
  return { hour: h || 0, minute: m || 0 };
}

/** Flatten instant on the same America/New_York calendar day as the event. */
export function flattenInstantUtc(ev: CalendarEvent): Date {
  const eventDate = new Date(ev.timeUtc);
  const day = etParts(eventDate);
  const { hour, minute } = parseHmm(flattenEtFor(ev));
  return zonedTimeToUtc(day.year, day.month, day.day, hour, minute, 0, TZ);
}

export function formatCountdown(ms: number): string {
  const sign = ms >= 0 ? "−" : "+";
  const abs = Math.abs(ms);
  const totalSec = Math.floor(abs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `T${sign}${h}:${pad2(m)}:${pad2(s)}`;
  return `T${sign}${m}:${pad2(s)}`;
}

export function eventMs(ev: CalendarEvent): number {
  return Date.parse(ev.timeUtc);
}

export function inPreArmWindow(nowMs: number, ev: CalendarEvent): boolean {
  const t = eventMs(ev);
  const until = t - nowMs;
  return until <= PRE_ARM_MS && until > BAND_MS;
}

export function inBandWindow(nowMs: number, ev: CalendarEvent): boolean {
  const t = eventMs(ev);
  const until = t - nowMs;
  return until <= BAND_MS && until >= -BAND_MS;
}

export function inSessionFlattenWindow(nowMs: number, ev: CalendarEvent): boolean {
  const flatten = flattenInstantUtc(ev).getTime();
  const delta = nowMs - flatten;
  return delta >= -FLATTEN_WINDOW_MS && delta <= FLATTEN_WINDOW_MS;
}

export function computeClock(
  now: Date,
  events: CalendarEvent[],
): ClockSnapshot {
  const nowMs = now.getTime();
  const sorted = [...events].sort((a, b) => eventMs(a) - eventMs(b));

  let inBand = false;
  let inPreArm = false;
  let inSessionFlatten = false;
  let bandEvent: CalendarEvent | null = null;
  let preArmEvent: CalendarEvent | null = null;
  let flattenEvent: CalendarEvent | null = null;

  for (const ev of sorted) {
    if (inBandWindow(nowMs, ev)) {
      inBand = true;
      if (!bandEvent) bandEvent = ev;
    }
    if (inPreArmWindow(nowMs, ev)) {
      inPreArm = true;
      if (!preArmEvent) preArmEvent = ev;
    }
    if (inSessionFlattenWindow(nowMs, ev)) {
      inSessionFlatten = true;
      if (!flattenEvent) flattenEvent = ev;
    }
  }

  let mode: GateMode = "idle";
  let activeEvent: CalendarEvent | null = null;
  if (inSessionFlatten) {
    mode = "SESSION FLATTEN";
    activeEvent = flattenEvent;
  } else if (inBand) {
    mode = "NO-STOP BAND";
    activeEvent = bandEvent;
  } else if (inPreArm) {
    mode = "PRE-ARM";
    activeEvent = preArmEvent;
  }

  const upcoming = sorted.find((ev) => eventMs(ev) > nowMs) ?? null;
  const nextEvent = upcoming;
  const focusEvent = activeEvent ?? nextEvent;

  let countdownMs: number | null = null;
  if (focusEvent) countdownMs = eventMs(focusEvent) - nowMs;

  const flattenEt = focusEvent ? flattenEtFor(focusEvent) : null;

  return {
    nowUtc: now.toISOString(),
    nowEt: formatEt(now),
    mode,
    banner: true,
    nextEvent,
    activeEvent,
    focusEvent,
    countdownMs,
    countdownLabel: countdownMs === null ? "—" : formatCountdown(countdownMs),
    flattenEt,
    inPreArm,
    inBand,
    inSessionFlatten,
  };
}

export function extractRoot(symbol: string): string | null {
  const compact = symbol.toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const root of GATED_ROOTS_LONGEST) {
    if (compact.startsWith(root)) return root;
  }
  return null;
}

export function isGatedSymbol(symbol: string): boolean {
  return extractRoot(symbol) !== null;
}

export function sameEtDay(a: Date, b: Date): boolean {
  const pa = etParts(a);
  const pb = etParts(b);
  return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day;
}

/** NFP, CPI, or any FOMC row. Jobless claims and other types are not prints. */
export function isPrintEvent(ev: CalendarEvent): boolean {
  const t = ev.type.toUpperCase();
  return t === "NFP" || t === "CPI" || t.includes("FOMC");
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

export type Stage3Arm = {
  armed: boolean;
  reason: "armed" | "no knowledge_time" | "knowledge_time not on a print day" | "knowledge_time before print";
};

/**
 * Stage-3 arm for a new MES stoch entry.
 * The ET day must have an NFP/CPI/FOMC row, the stamp must fall on that day
 * at or after the anchor print, and now must be at or after the stamp.
 */
export function stage3Arm(
  now: Date,
  knowledgeTime: string | null | undefined,
  events: CalendarEvent[],
): Stage3Arm {
  if (!knowledgeTime) return { armed: false, reason: "no knowledge_time" };
  const kt = Date.parse(knowledgeTime);
  if (!Number.isFinite(kt)) return { armed: false, reason: "no knowledge_time" };
  if (!sameEtDay(now, new Date(kt))) return { armed: false, reason: "no knowledge_time" };
  const anchor = knowledgeTimeAnchorEvent(now, events);
  if (!anchor) return { armed: false, reason: "knowledge_time not on a print day" };
  const anchorMs = Date.parse(anchor.timeUtc);
  if (!Number.isFinite(anchorMs) || kt < anchorMs) {
    return { armed: false, reason: "knowledge_time before print" };
  }
  if (now.getTime() < kt) return { armed: false, reason: "no knowledge_time" };
  return { armed: true, reason: "armed" };
}

/** No future NFP/CPI/FOMC inside this window → calendarStale on the status snapshot. */
export const CALENDAR_STALE_WITHIN_MS = 35 * 24 * 60 * 60 * 1000;

export function calendarIsStale(
  now: Date,
  events: CalendarEvent[],
  withinMs = CALENDAR_STALE_WITHIN_MS,
): boolean {
  const nowMs = now.getTime();
  const horizon = nowMs + withinMs;
  for (const ev of events) {
    if (!isPrintEvent(ev)) continue;
    const t = Date.parse(ev.timeUtc);
    if (Number.isFinite(t) && t > nowMs && t <= horizon) return false;
  }
  return true;
}

function seedInstant(
  id: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  type: string,
  flattenEt: string,
  label: string,
): CalendarEvent {
  return {
    id,
    timeUtc: zonedTimeToUtc(year, month, day, hour, minute, 0).toISOString().replace(".000Z", "Z"),
    type,
    flattenEt,
    label,
  };
}

/**
 * Print calendar. September 2026 rows match migration 001.
 * Later rows are 08:30 ET NFP/CPI (BLS schedules + OMB FY2027 PFEI) and
 * 14:00/14:30 ET FOMC statement + press conference (federalreserve.gov).
 * Wall times are America/New_York; UTC shifts with DST.
 */
export function seedEvents(): CalendarEvent[] {
  const upcoming: Array<[string, number, number, number, number, number, string, string, string]> = [
    ["nfp-2026-10-02", 2026, 10, 2, 8, 30, "NFP", "15:45", "September NFP"],
    ["cpi-2026-10-14", 2026, 10, 14, 8, 30, "CPI", "15:45", "September CPI"],
    ["fomc-statement-2026-10-28", 2026, 10, 28, 14, 0, "FOMC_STATEMENT", "15:30", "FOMC statement"],
    ["fomc-pc-2026-10-28", 2026, 10, 28, 14, 30, "FOMC_PC", "15:30", "FOMC press conference"],
    ["nfp-2026-11-06", 2026, 11, 6, 8, 30, "NFP", "15:45", "October NFP"],
    ["cpi-2026-11-10", 2026, 11, 10, 8, 30, "CPI", "15:45", "October CPI"],
    ["nfp-2026-12-04", 2026, 12, 4, 8, 30, "NFP", "15:45", "November NFP"],
    ["fomc-statement-2026-12-09", 2026, 12, 9, 14, 0, "FOMC_STATEMENT", "15:30", "FOMC statement"],
    ["fomc-pc-2026-12-09", 2026, 12, 9, 14, 30, "FOMC_PC", "15:30", "FOMC press conference"],
    ["cpi-2026-12-10", 2026, 12, 10, 8, 30, "CPI", "15:45", "November CPI"],
    ["nfp-2027-01-08", 2027, 1, 8, 8, 30, "NFP", "15:45", "December NFP"],
    ["cpi-2027-01-13", 2027, 1, 13, 8, 30, "CPI", "15:45", "December CPI"],
    ["fomc-statement-2027-01-27", 2027, 1, 27, 14, 0, "FOMC_STATEMENT", "15:30", "FOMC statement"],
    ["fomc-pc-2027-01-27", 2027, 1, 27, 14, 30, "FOMC_PC", "15:30", "FOMC press conference"],
    ["nfp-2027-02-05", 2027, 2, 5, 8, 30, "NFP", "15:45", "January NFP"],
    ["cpi-2027-02-11", 2027, 2, 11, 8, 30, "CPI", "15:45", "January CPI"],
    ["nfp-2027-03-05", 2027, 3, 5, 8, 30, "NFP", "15:45", "February NFP"],
    ["cpi-2027-03-10", 2027, 3, 10, 8, 30, "CPI", "15:45", "February CPI"],
    ["fomc-statement-2027-03-17", 2027, 3, 17, 14, 0, "FOMC_STATEMENT", "15:30", "FOMC statement"],
    ["fomc-pc-2027-03-17", 2027, 3, 17, 14, 30, "FOMC_PC", "15:30", "FOMC press conference"],
    ["nfp-2027-04-02", 2027, 4, 2, 8, 30, "NFP", "15:45", "March NFP"],
    ["cpi-2027-04-13", 2027, 4, 13, 8, 30, "CPI", "15:45", "March CPI"],
    ["fomc-statement-2027-04-28", 2027, 4, 28, 14, 0, "FOMC_STATEMENT", "15:30", "FOMC statement"],
    ["fomc-pc-2027-04-28", 2027, 4, 28, 14, 30, "FOMC_PC", "15:30", "FOMC press conference"],
    ["nfp-2027-05-07", 2027, 5, 7, 8, 30, "NFP", "15:45", "April NFP"],
    ["cpi-2027-05-12", 2027, 5, 12, 8, 30, "CPI", "15:45", "April CPI"],
    ["nfp-2027-06-04", 2027, 6, 4, 8, 30, "NFP", "15:45", "May NFP"],
    ["fomc-statement-2027-06-09", 2027, 6, 9, 14, 0, "FOMC_STATEMENT", "15:30", "FOMC statement"],
    ["fomc-pc-2027-06-09", 2027, 6, 9, 14, 30, "FOMC_PC", "15:30", "FOMC press conference"],
    ["cpi-2027-06-10", 2027, 6, 10, 8, 30, "CPI", "15:45", "May CPI"],
    ["nfp-2027-07-02", 2027, 7, 2, 8, 30, "NFP", "15:45", "June NFP"],
    ["cpi-2027-07-14", 2027, 7, 14, 8, 30, "CPI", "15:45", "June CPI"],
    ["fomc-statement-2027-07-28", 2027, 7, 28, 14, 0, "FOMC_STATEMENT", "15:30", "FOMC statement"],
    ["fomc-pc-2027-07-28", 2027, 7, 28, 14, 30, "FOMC_PC", "15:30", "FOMC press conference"],
    ["nfp-2027-08-06", 2027, 8, 6, 8, 30, "NFP", "15:45", "July NFP"],
    ["cpi-2027-08-11", 2027, 8, 11, 8, 30, "CPI", "15:45", "July CPI"],
    ["nfp-2027-09-03", 2027, 9, 3, 8, 30, "NFP", "15:45", "August NFP"],
    ["cpi-2027-09-14", 2027, 9, 14, 8, 30, "CPI", "15:45", "August CPI"],
    ["fomc-statement-2027-09-15", 2027, 9, 15, 14, 0, "FOMC_STATEMENT", "15:30", "FOMC statement"],
    ["fomc-pc-2027-09-15", 2027, 9, 15, 14, 30, "FOMC_PC", "15:30", "FOMC press conference"],
    ["nfp-2027-10-08", 2027, 10, 8, 8, 30, "NFP", "15:45", "September NFP"],
    ["cpi-2027-10-14", 2027, 10, 14, 8, 30, "CPI", "15:45", "September CPI"],
    ["fomc-statement-2027-10-27", 2027, 10, 27, 14, 0, "FOMC_STATEMENT", "15:30", "FOMC statement"],
    ["fomc-pc-2027-10-27", 2027, 10, 27, 14, 30, "FOMC_PC", "15:30", "FOMC press conference"],
    ["nfp-2027-11-05", 2027, 11, 5, 8, 30, "NFP", "15:45", "October NFP"],
    ["cpi-2027-11-10", 2027, 11, 10, 8, 30, "CPI", "15:45", "October CPI"],
    ["nfp-2027-12-03", 2027, 12, 3, 8, 30, "NFP", "15:45", "November NFP"],
    ["fomc-statement-2027-12-08", 2027, 12, 8, 14, 0, "FOMC_STATEMENT", "15:30", "FOMC statement"],
    ["fomc-pc-2027-12-08", 2027, 12, 8, 14, 30, "FOMC_PC", "15:30", "FOMC press conference"],
    ["cpi-2027-12-10", 2027, 12, 10, 8, 30, "CPI", "15:45", "November CPI"],
  ];
  return [
    {
      id: "nfp-2026-09-04",
      timeUtc: "2026-09-04T12:30:00Z",
      type: "NFP",
      flattenEt: "15:45",
      label: "August NFP",
    },
    {
      id: "cpi-2026-09-11",
      timeUtc: "2026-09-11T12:30:00Z",
      type: "CPI",
      flattenEt: "15:45",
      label: "August CPI",
    },
    {
      id: "fomc-statement-2026-09-16",
      timeUtc: "2026-09-16T18:00:00Z",
      type: "FOMC_STATEMENT",
      flattenEt: "15:30",
      label: "FOMC statement",
    },
    {
      id: "fomc-pc-2026-09-16",
      timeUtc: "2026-09-16T18:30:00Z",
      type: "FOMC_PC",
      flattenEt: "15:30",
      label: "FOMC press conference",
    },
    ...upcoming.map((row) => seedInstant(...row)),
  ];
}
