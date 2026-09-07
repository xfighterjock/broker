import { etParts, formatEt, pad2, zonedTimeToUtc } from "./clock";

export type MarketClosedReason = "weekend" | "holiday" | "early_close";

export interface MarketSession {
  /** True on Mon–Fri that are not NYSE full-day holidays. Orthogonal to GateMode. */
  cashOpen: boolean;
  closedReason: MarketClosedReason | null;
  holidayName: string | null;
  asOfEt: string;
  nextOpenEt: string | null;
}

export type NyseDayKind = "holiday" | "early_close";

export interface NyseDayInfo {
  name: string;
  kind: NyseDayKind;
}

function ymd(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function weekdayUtc(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function addDays(
  year: number,
  month: number,
  day: number,
  n: number,
): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Saturday → previous Friday; Sunday → following Monday. May spill into another year. */
export function observedDate(
  year: number,
  month: number,
  day: number,
): { year: number; month: number; day: number } {
  const wd = weekdayUtc(year, month, day);
  if (wd === 6) return addDays(year, month, day, -1);
  if (wd === 0) return addDays(year, month, day, 1);
  return { year, month, day };
}

/** 1-based day of the n-th weekday in a month. weekday: 0=Sun … 6=Sat. */
export function nthWeekdayOfMonth(
  year: number,
  month: number,
  weekday: number,
  n: number,
): number {
  const firstWd = weekdayUtc(year, month, 1);
  const first = 1 + ((weekday - firstWd + 7) % 7);
  return first + (n - 1) * 7;
}

/** 1-based day of the last weekday in a month. weekday: 0=Sun … 6=Sat. */
export function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const last = new Date(Date.UTC(year, month, 0));
  const lastDay = last.getUTCDate();
  const lastWd = last.getUTCDay();
  return lastDay - ((lastWd - weekday + 7) % 7);
}

/** Anonymous Gregorian computus. month is 3=March or 4=April. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

function put(
  map: Map<string, NyseDayInfo>,
  year: number,
  month: number,
  day: number,
  name: string,
  kind: NyseDayKind,
): void {
  const key = ymd(year, month, day);
  const prev = map.get(key);
  if (prev?.kind === "holiday") return;
  map.set(key, { name, kind });
}

/**
 * NYSE full-day holidays for `year`, plus early-close notes.
 * New Year's Saturday observance may land on Dec 31 of `year - 1`.
 */
export function nyseCalendarForYear(year: number): Map<string, NyseDayInfo> {
  const map = new Map<string, NyseDayInfo>();

  const ny = observedDate(year, 1, 1);
  put(map, ny.year, ny.month, ny.day, "New Year's Day", "holiday");

  put(map, year, 1, nthWeekdayOfMonth(year, 1, 1, 3), "Martin Luther King Jr. Day", "holiday");
  put(map, year, 2, nthWeekdayOfMonth(year, 2, 1, 3), "Presidents' Day", "holiday");

  const easter = easterSunday(year);
  const gf = addDays(year, easter.month, easter.day, -2);
  put(map, gf.year, gf.month, gf.day, "Good Friday", "holiday");

  put(map, year, 5, lastWeekdayOfMonth(year, 5, 1), "Memorial Day", "holiday");

  const jun = observedDate(year, 6, 19);
  put(map, jun.year, jun.month, jun.day, "Juneteenth", "holiday");

  const indy = observedDate(year, 7, 4);
  put(map, indy.year, indy.month, indy.day, "Independence Day", "holiday");

  put(map, year, 9, nthWeekdayOfMonth(year, 9, 1, 1), "Labor Day", "holiday");

  const thanksgiving = nthWeekdayOfMonth(year, 11, 4, 4);
  put(map, year, 11, thanksgiving, "Thanksgiving", "holiday");

  const xmas = observedDate(year, 12, 25);
  put(map, xmas.year, xmas.month, xmas.day, "Christmas", "holiday");

  const afterTg = addDays(year, 11, thanksgiving, 1);
  put(map, afterTg.year, afterTg.month, afterTg.day, "day after Thanksgiving", "early_close");

  const jul3Wd = weekdayUtc(year, 7, 3);
  if (jul3Wd !== 0 && jul3Wd !== 6) put(map, year, 7, 3, "July 3", "early_close");

  const eveWd = weekdayUtc(year, 12, 24);
  if (eveWd !== 0 && eveWd !== 6) put(map, year, 12, 24, "Christmas Eve", "early_close");

  const nyeWd = weekdayUtc(year, 12, 31);
  if (nyeWd !== 0 && nyeWd !== 6) put(map, year, 12, 31, "New Year's Eve", "early_close");

  return map;
}

export function nyseDayOn(year: number, month: number, day: number): NyseDayInfo | null {
  const key = ymd(year, month, day);
  const here = nyseCalendarForYear(year).get(key);
  const next = nyseCalendarForYear(year + 1).get(key);
  if (here?.kind === "holiday") return here;
  if (next?.kind === "holiday") return next;
  return here ?? next ?? null;
}

function isWeekend(year: number, month: number, day: number): boolean {
  const wd = weekdayUtc(year, month, day);
  return wd === 0 || wd === 6;
}

function isFullHoliday(year: number, month: number, day: number): NyseDayInfo | null {
  const info = nyseDayOn(year, month, day);
  return info?.kind === "holiday" ? info : null;
}

function nextCashOpenEt(now: Date): string | null {
  const p = etParts(now);
  for (let i = 0; i < 16; i++) {
    const d = addDays(p.year, p.month, p.day, i);
    if (isWeekend(d.year, d.month, d.day)) continue;
    if (isFullHoliday(d.year, d.month, d.day)) continue;
    const open = zonedTimeToUtc(d.year, d.month, d.day, 9, 30, 0);
    if (open.getTime() > now.getTime()) return formatEt(open);
  }
  return null;
}

export function computeMarketSession(now: Date): MarketSession {
  const p = etParts(now);
  const weekend = isWeekend(p.year, p.month, p.day);
  const info = nyseDayOn(p.year, p.month, p.day);
  const holiday = info?.kind === "holiday" ? info : null;
  const early = !holiday && info?.kind === "early_close" ? info : null;

  let cashOpen = !weekend && !holiday;
  let closedReason: MarketClosedReason | null = null;
  let holidayName: string | null = null;

  if (holiday) {
    cashOpen = false;
    closedReason = "holiday";
    holidayName = holiday.name;
  } else if (weekend) {
    cashOpen = false;
    closedReason = "weekend";
  } else if (early) {
    closedReason = "early_close";
    holidayName = early.name;
  }

  return {
    cashOpen,
    closedReason,
    holidayName,
    asOfEt: formatEt(now),
    nextOpenEt: nextCashOpenEt(now),
  };
}

/** Web + iOS copy. Null when the cash session is a normal weekday (no early-close note). */
export function marketSessionBanner(session: MarketSession): string | null {
  if (session.cashOpen) {
    if (session.closedReason === "early_close") {
      return `US cash market early close — ${session.holidayName ?? "early close"}`;
    }
    return null;
  }
  if (session.closedReason === "weekend") return "US cash market closed — weekend";
  if (session.closedReason === "holiday") {
    return `US cash market closed — ${session.holidayName ?? "holiday"}`;
  }
  if (session.closedReason === "early_close") {
    return `US cash market closed — ${session.holidayName ?? "early close"}`;
  }
  return "US cash market closed";
}
