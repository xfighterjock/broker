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

export function seedEvents(): CalendarEvent[] {
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
  ];
}
