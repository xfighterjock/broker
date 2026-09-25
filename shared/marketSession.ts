import { etParts, formatEt, pad2, zonedTimeToUtc } from "./clock";
import {
  RISKOFF_ETF_EARLY_CLOSE_REBALANCE_MINUTE,
  RISKOFF_ETF_REBALANCE_MINUTE,
} from "./constants";

export type MarketClosedReason = "weekend" | "holiday" | "early_close";

/** NYSE cash open, 09:30 America/New_York. */
const CASH_OPEN_MINUTE = 9 * 60 + 30;

export interface MarketSession {
  /** True on Mon–Fri that are not NYSE full-day holidays. Orthogonal to GateMode. */
  cashOpen: boolean;
  /**
   * True only while now is inside today's cash session: 09:30 ET until the
   * cash close (16:00 ET, 13:00 ET on early-close days). Distinct from cashOpen.
   */
  inCashSession: boolean;
  closedReason: MarketClosedReason | null;
  holidayName: string | null;
  asOfEt: string;
  /** Next 09:30 ET cash open on a regular session day, display form. */
  nextOpenEt: string | null;
  /** Cash close that ends the current or next session, display form (ET). */
  nextCloseEt: string | null;
  /** ISO-8601 instant of nextOpenEt. Client countdown source. */
  nextOpenAt: string | null;
  /** ISO-8601 instant of nextCloseEt. Client countdown source. */
  nextCloseAt: string | null;
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

/**
 * Minute-of-day of the NYSE cash close, or null on weekends and full holidays.
 * Early-close days close at 13:00 ET. Same instants the risk-off overlay
 * rebalance uses (RISKOFF_ETF_REBALANCE_MINUTE / EARLY_CLOSE).
 */
export function cashSessionCloseMinute(year: number, month: number, day: number): number | null {
  if (isWeekend(year, month, day)) return null;
  const info = nyseDayOn(year, month, day);
  if (info?.kind === "holiday") return null;
  if (info?.kind === "early_close") return RISKOFF_ETF_EARLY_CLOSE_REBALANCE_MINUTE;
  return RISKOFF_ETF_REBALANCE_MINUTE;
}

function isSessionDay(year: number, month: number, day: number): boolean {
  return cashSessionCloseMinute(year, month, day) !== null;
}

function sessionOpenInstant(year: number, month: number, day: number): Date {
  const hour = Math.floor(CASH_OPEN_MINUTE / 60);
  const minute = CASH_OPEN_MINUTE % 60;
  return zonedTimeToUtc(year, month, day, hour, minute, 0);
}

function sessionCloseInstant(year: number, month: number, day: number): Date {
  const minuteOfDay = cashSessionCloseMinute(year, month, day);
  if (minuteOfDay === null) throw new Error("not a cash session day");
  return zonedTimeToUtc(
    year,
    month,
    day,
    Math.floor(minuteOfDay / 60),
    minuteOfDay % 60,
    0,
  );
}

/** Next 09:30 ET open strictly after `now` on a regular session day. */
export function nextCashOpenDate(now: Date): Date | null {
  const p = etParts(now);
  for (let i = 0; i < 16; i++) {
    const d = addDays(p.year, p.month, p.day, i);
    if (!isSessionDay(d.year, d.month, d.day)) continue;
    const open = sessionOpenInstant(d.year, d.month, d.day);
    if (open.getTime() > now.getTime()) return open;
  }
  return null;
}

/**
 * Next cash close strictly after `now`. On a session day before the close
 * (including pre-open) that is today's close — 16:00 ET, or 13:00 ET when
 * the calendar marks an early close. Otherwise the close of the next session.
 */
export function nextCashCloseDate(now: Date): Date | null {
  const p = etParts(now);
  if (isSessionDay(p.year, p.month, p.day)) {
    const close = sessionCloseInstant(p.year, p.month, p.day);
    if (close.getTime() > now.getTime()) return close;
  }
  const open = nextCashOpenDate(now);
  if (!open) return null;
  const op = etParts(open);
  return sessionCloseInstant(op.year, op.month, op.day);
}

/** Inside [09:30, cash close) ET on a regular or early-close session day. */
export function cashSessionIsOpen(now: Date): boolean {
  const p = etParts(now);
  if (!isSessionDay(p.year, p.month, p.day)) return false;
  const open = sessionOpenInstant(p.year, p.month, p.day);
  const close = sessionCloseInstant(p.year, p.month, p.day);
  const t = now.getTime();
  return t >= open.getTime() && t < close.getTime();
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

  const nextOpen = nextCashOpenDate(now);
  const nextClose = nextCashCloseDate(now);

  return {
    cashOpen,
    inCashSession: cashSessionIsOpen(now),
    closedReason,
    holidayName,
    asOfEt: formatEt(now),
    nextOpenEt: nextOpen ? formatEt(nextOpen) : null,
    nextCloseEt: nextClose ? formatEt(nextClose) : null,
    nextOpenAt: nextOpen ? nextOpen.toISOString() : null,
    nextCloseAt: nextClose ? nextClose.toISOString() : null,
  };
}

export type CashCountdownKind = "open" | "close";

export interface CashCountdownTarget {
  kind: CashCountdownKind;
  atMs: number;
}

/** Session fields the client needs to pick a countdown without a new calendar. */
export type CashCountdownSession = Pick<
  MarketSession,
  "inCashSession" | "nextOpenAt" | "nextCloseAt"
>;

function parseInstant(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Which instant to count toward. Trusts server timestamps. If the phase
 * instant has already passed (stale snapshot), flips to the other future
 * instant so the label can change without another request.
 */
export function cashCountdownTarget(
  session: CashCountdownSession,
  nowMs: number,
): CashCountdownTarget | null {
  const openMs = parseInstant(session.nextOpenAt);
  const closeMs = parseInstant(session.nextCloseAt);
  if (session.inCashSession) {
    if (closeMs !== null && closeMs > nowMs) return { kind: "close", atMs: closeMs };
    if (openMs !== null && openMs > nowMs) return { kind: "open", atMs: openMs };
    return null;
  }
  if (openMs !== null && openMs > nowMs) return { kind: "open", atMs: openMs };
  if (closeMs !== null && closeMs > nowMs) return { kind: "close", atMs: closeMs };
  return null;
}

/** `2h 14m 03s`, `14m 03s`, or `03s`. Drops zero higher units. Seconds always shown. */
export function formatCashCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const sec = `${pad2(s)}s`;
  if (h > 0) return `${h}h ${m}m ${sec}`;
  if (m > 0) return `${m}m ${sec}`;
  return sec;
}

export function cashCountdownLabel(kind: CashCountdownKind, remainingMs: number): string {
  const head = kind === "open" ? "Cash open in" : "Cash close in";
  return `${head} ${formatCashCountdown(remainingMs)}`;
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
