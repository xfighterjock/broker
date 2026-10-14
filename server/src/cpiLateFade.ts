import { CPI_LATE_FADE_ENABLED } from "../../shared/constants";
import { etParts, pad2, sameEtDay, stage3Arm } from "../../shared/clock";
import { nyseDayOn } from "../../shared/marketSession";
import type { CalendarEvent, GateMode, Position, Side } from "../../shared/types";
import {
  DAY_STOCH_QTY,
  DAY_STOCH_SYMBOL,
  dropIncompleteLastBar,
  etMinutes,
  etWeekday,
  gateBlocksDayEntries,
  type DayBuy,
  type DaySell,
  type MinuteBar,
} from "./dayMomentum";

/**
 * CPI-day late-session fade (paper hypothesis, strategy id `cpiLateFade`).
 * Reference is the fade MES 5-minute series (Massive Futures front-month,
 * five calendar days, newest-first; Yahoo MES=F `range=5d` fallback), merged
 * with the day series. The stochastic leg keeps Yahoo `range=1d` / Massive
 * two-day oldest-first and does not see this merge. Prior cash close is the
 * previous NYSE session's 15:55 ET bar close (window start; that bar ends at
 * 16:00). Weekends and full NYSE holidays are not that session. The 10:30 ET
 * price is the 10:25 ET bar close. Missing, stale, or a zero move is no trade.
 * Provenance: Yahoo SPY 60m, 2023-11-13 through 2026-10-09, FRED CPIAUCNS
 * release dates through 2026-04-10. Paper only.
 */
export const CPI_LATE_FADE_STRATEGY_ID = "cpiLateFade";
export const CPI_LATE_FADE_STOP_FRAC = 0.004;
export const CPI_LATE_FADE_ENTRY_MIN = 15 * 60 + 30;
/** Half-open window so a 5-minute autopilot pass lands once. */
export const CPI_LATE_FADE_ENTRY_UNTIL_MIN = 15 * 60 + 35;
export const CPI_LATE_FADE_FLAT_MIN = 15 * 60 + 59;
/** Latest completed bar may be this old (15-minute delayed feed plus one bar). */
export const CPI_LATE_FADE_STALE_MS = 30 * 60 * 1000;
const BAR_MS = 5 * 60 * 1000;
const PRIOR_CLOSE_MIN = 15 * 60 + 55;
const PRICE_1030_MIN = 10 * 60 + 25;

export type CpiLateFadeSignal =
  | {
      ok: true;
      /** +1 when 10:30 is above the prior close (fade shorts). -1 fades long. */
      moveSign: 1 | -1;
      priorClose: number;
      price1030: number;
      entryRef: number;
    }
  | { ok: false; reason: string };

function finitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function etKeyFromParts(year: number, month: number, day: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

function etKey(ts: number): string {
  const p = etParts(new Date(ts));
  return etKeyFromParts(p.year, p.month, p.day);
}

function etMinuteOf(ts: number): number {
  const p = etParts(new Date(ts));
  return p.hour * 60 + p.minute;
}

/**
 * Previous NYSE cash session in America/New_York. Skips weekends and full
 * holidays (early-close days still count). Walks at most two weeks.
 */
export function previousWeekdayKey(now: Date): string {
  const p = etParts(now);
  const cursor = new Date(Date.UTC(p.year, p.month - 1, p.day));
  let fallback = "";
  for (let i = 0; i < 14; i++) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth() + 1;
    const day = cursor.getUTCDate();
    const wd = cursor.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    const key = etKeyFromParts(year, month, day);
    if (!fallback) fallback = key;
    if (nyseDayOn(year, month, day)?.kind === "holiday") continue;
    return key;
  }
  return fallback || etKeyFromParts(p.year, p.month, p.day);
}

/**
 * Day series plus the fade's longer series. Day bars win on a shared timestamp
 * so the stochastic feed stays the source for today's prints. An empty fade
 * series leaves the day series as it is.
 */
export function mergeCpiLateFadeBars(dayBars: MinuteBar[], fadeBars: MinuteBar[]): MinuteBar[] {
  if (fadeBars.length === 0) return dayBars;
  if (dayBars.length === 0) return fadeBars;
  const byTs = new Map<number, MinuteBar>();
  for (const b of dayBars) byTs.set(b.ts, b);
  for (const b of fadeBars) {
    if (!byTs.has(b.ts)) byTs.set(b.ts, b);
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

const QUIET_CPI_LATE_FADE_SKIPS = new Set([
  "outside cpiLateFade entry window",
  "not a CPI day",
  "weekend",
  "hold",
  "flatten",
  "stop",
  "loss cap",
  "buy",
  "sell",
]);

let cpiLateFadeSkipLoggedDay: string | null = null;

export function resetCpiLateFadeSkipLog(): void {
  cpiLateFadeSkipLoggedDay = null;
}

/**
 * One info line per ET day when the 15:30 entry window skips. Routine
 * out-of-window and non-CPI passes stay quiet. stdout so journalctl shows it.
 */
export function noteCpiLateFadeSkip(now: Date, reason: string): void {
  if (!reason || QUIET_CPI_LATE_FADE_SKIPS.has(reason)) return;
  const mins = etMinutes(now);
  if (mins < CPI_LATE_FADE_ENTRY_MIN || mins >= CPI_LATE_FADE_ENTRY_UNTIL_MIN) return;
  const day = etKey(now.getTime());
  if (cpiLateFadeSkipLoggedDay === day) return;
  cpiLateFadeSkipLoggedDay = day;
  console.info(`[EventGate] cpiLateFade skip: ${reason}`);
}

function findBar(bars: MinuteBar[], ymd: string, minute: number): MinuteBar | null {
  let found: MinuteBar | null = null;
  for (const b of bars) {
    if (etKey(b.ts) !== ymd || etMinuteOf(b.ts) !== minute) continue;
    if (!finitePositive(b.close)) continue;
    if (!found || b.ts > found.ts) found = b;
  }
  return found;
}

/**
 * Sign of the prior regular-session close → 10:30 ET move.
 * A missing bar, a stale series, or a zero move does not pick a side.
 */
export function cpiLateFadeSignal(now: Date, bars: MinuteBar[]): CpiLateFadeSignal {
  const completed = dropIncompleteLastBar(bars, now.getTime(), BAR_MS);
  const today = etKey(now.getTime());
  const at1030 = findBar(completed, today, PRICE_1030_MIN);
  if (!at1030) return { ok: false, reason: "missing MES 5m 10:30" };
  const prior = findBar(completed, previousWeekdayKey(now), PRIOR_CLOSE_MIN);
  if (!prior) return { ok: false, reason: "missing MES 5m prior close" };
  if (at1030.close === prior.close) return { ok: false, reason: "flat signal" };
  let latest: MinuteBar | null = null;
  for (const b of completed) {
    if (!finitePositive(b.close)) continue;
    if (!latest || b.ts > latest.ts) latest = b;
  }
  if (!latest) return { ok: false, reason: "missing MES 5m bars" };
  const age = now.getTime() - (latest.ts + BAR_MS);
  if (age > CPI_LATE_FADE_STALE_MS) return { ok: false, reason: "stale MES 5m bars" };
  return {
    ok: true,
    moveSign: at1030.close > prior.close ? 1 : -1,
    priorClose: prior.close,
    price1030: at1030.close,
    entryRef: latest.close,
  };
}

export function cpiLateFadeStopPrice(side: Side, entry: number): number {
  if (!finitePositive(entry)) return NaN;
  const mul = side === "Buy" ? 1 - CPI_LATE_FADE_STOP_FRAC : 1 + CPI_LATE_FADE_STOP_FRAC;
  return entry * mul;
}

export function cpiLateFadeAdverse(side: Position["side"], entry: number, mark: number): number | null {
  if (!finitePositive(entry) || !Number.isFinite(mark)) return null;
  if (side === "Long") return (entry - mark) / entry;
  if (side === "Short") return (mark - entry) / entry;
  return null;
}

function isDayMes(p: Position): boolean {
  const s = p.symbol.toUpperCase();
  return s === "MES" || s === "MES=F" || p.root === "MES";
}

export function isOpenCpiLateFade(p: Position): boolean {
  return (
    p.cpiLateFade === true &&
    p.sleeveId === "day" &&
    p.side !== "Flat" &&
    p.qty > 0 &&
    !p.vertical &&
    !p.overlay &&
    isDayMes(p)
  );
}

export function openCpiLateFade(positions: Position[]): Position | null {
  for (const p of positions) {
    if (isOpenCpiLateFade(p)) return p;
  }
  return null;
}

/** Untagged day-sleeve MES. The stochastic leg. The fade does not net with it. */
export function openStochMes(positions: Position[]): Position | null {
  for (const p of positions) {
    if (p.cpiLateFade === true) continue;
    if (p.sleeveId !== "day" || p.side === "Flat" || p.qty <= 0) continue;
    if (p.vertical || p.overlay) continue;
    if (isDayMes(p)) return p;
  }
  return null;
}

/** CPI rows only. NFP, FOMC, claims, and PPI do not qualify. */
export function cpiReleaseOnEtDay(now: Date, events: CalendarEvent[]): CalendarEvent | null {
  for (const ev of events) {
    if (ev.type.trim().toUpperCase() !== "CPI") continue;
    const t = Date.parse(ev.timeUtc);
    if (!Number.isFinite(t)) continue;
    if (sameEtDay(now, new Date(t))) return ev;
  }
  return null;
}

function latestClose(bars: MinuteBar[], now: Date): number | null {
  const completed = dropIncompleteLastBar(bars, now.getTime(), BAR_MS);
  let latest: MinuteBar | null = null;
  for (const b of completed) {
    if (!finitePositive(b.close)) continue;
    if (!latest || b.ts > latest.ts) latest = b;
  }
  return latest ? latest.close : null;
}

/**
 * Paper decision. New entries follow `enabled` (default `CPI_LATE_FADE_ENABLED`).
 * An open lot still flattens at 15:59 ET, on the 0.4% stop, and on the sleeve
 * loss cap when the flag or day AUTO is off — it does not stay on overnight.
 * RISK ON/OFF is not an input.
 */
export function decideCpiLateFade(input: {
  now: Date;
  gateMode: GateMode;
  bars: MinuteBar[];
  positions: Position[];
  sleeveLossCapUsd: number;
  sleeveRealizedPnlUsd: number;
  knowledgeTime?: string | null;
  events?: CalendarEvent[];
  /** New entries. Omit to use CPI_LATE_FADE_ENABLED. Exits ignore this. */
  enabled?: boolean;
}): { buy: DayBuy | null; sells: DaySell[]; reason: string } {
  const empty = { buy: null as DayBuy | null, sells: [] as DaySell[] };
  const events = input.events ?? [];
  const open = openCpiLateFade(input.positions);
  const mins = etMinutes(input.now);
  const weekday = etWeekday(input.now);
  const lossHit = input.sleeveRealizedPnlUsd <= -input.sleeveLossCapUsd;

  if (open) {
    if (!weekday || mins >= CPI_LATE_FADE_FLAT_MIN || mins < CPI_LATE_FADE_ENTRY_MIN) {
      return {
        ...empty,
        sells: [{ sleeveId: "day", symbol: open.symbol, reason: `${CPI_LATE_FADE_STRATEGY_ID} flatten 15:59 ET` }],
        reason: "flatten",
      };
    }
    if (lossHit) {
      return {
        ...empty,
        sells: [{ sleeveId: "day", symbol: open.symbol, reason: `${CPI_LATE_FADE_STRATEGY_ID} sleeve loss cap` }],
        reason: "loss cap",
      };
    }
    const mark = latestClose(input.bars, input.now);
    const adverse = mark === null ? null : cpiLateFadeAdverse(open.side, open.avgPrice, mark);
    if (adverse !== null && adverse >= CPI_LATE_FADE_STOP_FRAC) {
      return {
        ...empty,
        sells: [{ sleeveId: "day", symbol: open.symbol, reason: `${CPI_LATE_FADE_STRATEGY_ID} stop 0.4%` }],
        reason: "stop",
      };
    }
    return { ...empty, reason: "hold" };
  }

  const entriesOn = input.enabled ?? CPI_LATE_FADE_ENABLED;
  if (!entriesOn) return { ...empty, reason: "cpiLateFade off" };
  if (!weekday) return { ...empty, reason: "weekend" };
  if (!cpiReleaseOnEtDay(input.now, events)) return { ...empty, reason: "not a CPI day" };
  if (gateBlocksDayEntries(input.gateMode)) return { ...empty, reason: `gate ${input.gateMode}` };
  const arm = stage3Arm(input.now, input.knowledgeTime, events);
  if (!arm.armed) return { ...empty, reason: arm.reason };
  if (mins < CPI_LATE_FADE_ENTRY_MIN || mins >= CPI_LATE_FADE_ENTRY_UNTIL_MIN) {
    return { ...empty, reason: "outside cpiLateFade entry window" };
  }
  if (lossHit) return { ...empty, reason: "sleeve loss cap" };
  if (openStochMes(input.positions)) return { ...empty, reason: "MES already held by stoch" };

  const signal = cpiLateFadeSignal(input.now, input.bars);
  if (!signal.ok) return { ...empty, reason: signal.reason };

  const side: Side = signal.moveSign > 0 ? "Sell" : "Buy";
  const stopPrice = cpiLateFadeStopPrice(side, signal.entryRef);
  if (!Number.isFinite(stopPrice)) return { ...empty, reason: "missing MES 5m bars" };
  const dir = side === "Buy" ? "long" : "short";
  return {
    buy: {
      sleeveId: "day",
      symbol: DAY_STOCH_SYMBOL,
      side,
      qty: DAY_STOCH_QTY,
      stopPrice,
      thesis: `${CPI_LATE_FADE_STRATEGY_ID} ${dir} 1 MES`,
    },
    sells: [],
    reason: side === "Buy" ? "buy" : "sell",
  };
}
