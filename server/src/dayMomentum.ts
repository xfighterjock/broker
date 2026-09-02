import { etParts } from "../../shared/clock";
import type { GateMode, Position, Side } from "../../shared/types";

export const DAY_STOCH_SYMBOL = "MES=F";
export const DAY_STOCH_PERIOD = 14;
export const DAY_STOCH_K_SMOOTH = 3;
export const DAY_STOCH_D_SMOOTH = 3;
export const DAY_STOCH_OVERSOLD = 20;
export const DAY_STOCH_OVERBOUGHT = 80;
export const DAY_STOCH_TICK = 0.25;
export const DAY_STOCH_STOP_TICKS = 8;
export const DAY_STOCH_QTY = 1;
export const DAY_ENTRY_START_MIN = 9 * 60 + 35;
export const DAY_ENTRY_CUTOFF_MIN = 15 * 60 + 45;
export const DAY_FLAT_MIN = 15 * 60 + 45;

export type MinuteBar = {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StochPoint = { k: number; d: number };

export type DayBuy = {
  sleeveId: "day";
  symbol: string;
  side: Side;
  qty: number;
  stopPrice: number;
  thesis: string;
};

export type DaySell = {
  sleeveId: "day";
  symbol: string;
  reason: string;
};

function finite(n: number): boolean {
  return Number.isFinite(n);
}

export function etMinutes(now: Date): number {
  const p = etParts(now);
  return p.hour * 60 + p.minute;
}

export function etWeekday(now: Date): boolean {
  const w = etParts(now).weekday;
  return w !== "Sat" && w !== "Sun";
}

export function isRthBar(tsMs: number): boolean {
  const p = etParts(new Date(tsMs));
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const m = p.hour * 60 + p.minute;
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

export function gateBlocksDayEntries(mode: GateMode): boolean {
  return mode !== "idle";
}

export function sma(values: number[], period: number): number | null {
  if (period < 1 || values.length < period) return null;
  const slice = values.slice(-period);
  let s = 0;
  for (const v of slice) {
    if (!finite(v)) return null;
    s += v;
  }
  return s / period;
}

export function sessionVwap(bars: MinuteBar[]): number | null {
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    if (!isRthBar(b.ts)) continue;
    if (!(b.volume > 0) || !finite(b.high) || !finite(b.low) || !finite(b.close)) continue;
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vol += b.volume;
  }
  if (!(vol > 0)) return null;
  return pv / vol;
}

export function stochasticKd(
  bars: MinuteBar[],
  period = DAY_STOCH_PERIOD,
  kSmooth = DAY_STOCH_K_SMOOTH,
  dSmooth = DAY_STOCH_D_SMOOTH,
): StochPoint[] {
  const rawK: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i + 1 < period) {
      rawK.push(NaN);
      continue;
    }
    const window = bars.slice(i + 1 - period, i + 1);
    let lo = Infinity;
    let hi = -Infinity;
    for (const b of window) {
      if (b.low < lo) lo = b.low;
      if (b.high > hi) hi = b.high;
    }
    const span = hi - lo;
    rawK.push(span <= 0 ? 50 : (100 * (bars[i].close - lo)) / span);
  }
  const slowK: number[] = [];
  for (let i = 0; i < rawK.length; i++) {
    const win = rawK.slice(Math.max(0, i + 1 - kSmooth), i + 1);
    slowK.push(win.length < kSmooth || win.some((x) => !finite(x)) ? NaN : (win.reduce((a, b) => a + b, 0) / kSmooth));
  }
  const out: StochPoint[] = [];
  for (let i = 0; i < slowK.length; i++) {
    const win = slowK.slice(Math.max(0, i + 1 - dSmooth), i + 1);
    const d = win.length < dSmooth || win.some((x) => !finite(x)) ? NaN : win.reduce((a, b) => a + b, 0) / dSmooth;
    out.push({ k: slowK[i], d });
  }
  return out;
}

export function parseYahooFiveMinuteBars(body: unknown): MinuteBar[] {
  const result = (body as { chart?: { result?: Array<{
    timestamp?: number[];
    indicators?: { quote?: Array<{
      open?: Array<number | null>;
      high?: Array<number | null>;
      low?: Array<number | null>;
      close?: Array<number | null>;
      volume?: Array<number | null>;
    }> };
  }> } }).chart?.result?.[0];
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) return [];
  const out: MinuteBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i];
    const o = q.open?.[i];
    const h = q.high?.[i];
    const l = q.low?.[i];
    const c = q.close?.[i];
    const v = q.volume?.[i];
    if (typeof t !== "number" || !(t > 0)) continue;
    if (typeof o !== "number" || !finite(o)) continue;
    if (typeof h !== "number" || !finite(h)) continue;
    if (typeof l !== "number" || !finite(l)) continue;
    if (typeof c !== "number" || !finite(c)) continue;
    out.push({
      ts: t * 1000,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: typeof v === "number" && finite(v) ? v : 0,
    });
  }
  return out;
}

export function dropIncompleteLastBar(bars: MinuteBar[], nowMs: number, barMs = 5 * 60 * 1000): MinuteBar[] {
  if (bars.length === 0) return bars;
  const last = bars[bars.length - 1];
  if (nowMs - last.ts < barMs) return bars.slice(0, -1);
  return bars;
}

export function stopForLong(close: number, signalLow: number): number {
  const minTicks = DAY_STOCH_STOP_TICKS * DAY_STOCH_TICK;
  const byBar = close - signalLow;
  const dist = Math.max(minTicks, byBar > 0 ? byBar : minTicks);
  return close - dist;
}

export function stopForShort(close: number, signalHigh: number): number {
  const minTicks = DAY_STOCH_STOP_TICKS * DAY_STOCH_TICK;
  const byBar = signalHigh - close;
  const dist = Math.max(minTicks, byBar > 0 ? byBar : minTicks);
  return close + dist;
}

function openDayMes(positions: Position[]): Position | null {
  for (const p of positions) {
    if (p.sleeveId !== "day" || p.side === "Flat" || p.qty <= 0) continue;
    if (p.vertical || p.overlay) continue;
    const s = p.symbol.toUpperCase();
    if (s === "MES" || s === "MES=F" || (p.root && p.root === "MES")) return p;
  }
  return null;
}

export function decideDayMomentum(input: {
  now: Date;
  gateMode: GateMode;
  bars: MinuteBar[];
  positions: Position[];
  sleeveLossCapUsd: number;
  sleeveRealizedPnlUsd: number;
}): { buy: DayBuy | null; sells: DaySell[]; reason: string } {
  const empty = { buy: null as DayBuy | null, sells: [] as DaySell[] };
  const open = openDayMes(input.positions);
  const mins = etMinutes(input.now);
  const weekday = etWeekday(input.now);

  if (open && (!weekday || mins >= DAY_FLAT_MIN)) {
    return { ...empty, sells: [{ sleeveId: "day", symbol: open.symbol, reason: "session flatten 15:45 ET" }], reason: "flatten" };
  }
  if (open && input.sleeveRealizedPnlUsd <= -input.sleeveLossCapUsd) {
    return { ...empty, sells: [{ sleeveId: "day", symbol: open.symbol, reason: "sleeve loss cap" }], reason: "loss cap" };
  }

  const completed = dropIncompleteLastBar(input.bars, input.now.getTime());
  const kd = stochasticKd(completed);
  const vwap = sessionVwap(completed);
  if (completed.length < DAY_STOCH_PERIOD + DAY_STOCH_K_SMOOTH + DAY_STOCH_D_SMOOTH - 2 || kd.length < 2 || vwap === null) {
    return { ...empty, reason: "not enough MES 5m bars" };
  }
  const i = kd.length - 1;
  const k = kd[i].k;
  const d = kd[i].d;
  const kPrev = kd[i - 1].k;
  const dPrev = kd[i - 1].d;
  const bar = completed[i];
  if (![k, d, kPrev, dPrev, bar.close].every(finite)) {
    return { ...empty, reason: "stochastic not ready" };
  }

  if (open) {
    const against =
      (open.side === "Long" && bar.close < vwap) ||
      (open.side === "Short" && bar.close > vwap);
    if (against) {
      return { buy: null, sells: [{ sleeveId: "day", symbol: open.symbol, reason: "VWAP lost" }], reason: "exit VWAP" };
    }
    return { ...empty, reason: "hold" };
  }

  if (!weekday) return { ...empty, reason: "weekend" };
  if (gateBlocksDayEntries(input.gateMode)) return { ...empty, reason: `gate ${input.gateMode}` };
  if (mins < DAY_ENTRY_START_MIN || mins >= DAY_ENTRY_CUTOFF_MIN) return { ...empty, reason: "outside RTH entry window" };
  if (input.sleeveRealizedPnlUsd <= -input.sleeveLossCapUsd) return { ...empty, reason: "sleeve loss cap" };

  const longX = kPrev <= DAY_STOCH_OVERSOLD && kPrev <= dPrev && k > d;
  const shortX = kPrev >= DAY_STOCH_OVERBOUGHT && kPrev >= dPrev && k < d;
  if (longX && bar.close > vwap) {
    return {
      buy: {
        sleeveId: "day",
        symbol: DAY_STOCH_SYMBOL,
        side: "Buy",
        qty: DAY_STOCH_QTY,
        stopPrice: stopForLong(bar.close, bar.low),
        thesis: `auto day MES stoch 14,3,3 long VWAP k ${k.toFixed(1)}`,
      },
      sells: [],
      reason: "buy",
    };
  }
  if (shortX && bar.close < vwap) {
    return {
      buy: {
        sleeveId: "day",
        symbol: DAY_STOCH_SYMBOL,
        side: "Sell",
        qty: DAY_STOCH_QTY,
        stopPrice: stopForShort(bar.close, bar.high),
        thesis: `auto day MES stoch 14,3,3 short VWAP k ${k.toFixed(1)}`,
      },
      sells: [],
      reason: "sell",
    };
  }
  return { ...empty, reason: "no signal" };
}
