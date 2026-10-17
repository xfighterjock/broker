/**
 * Live paper inputs for the csp sleeve: daily scan, E*TRADE chain quotes,
 * and the chain recorder. Read-only market data. Never an order endpoint.
 */

import { CSP_UNIVERSE } from "../../shared/cspUniverse";
import type { OptionLeg, Position } from "../../shared/types";
import { etradeAuthState, fetchOptionChain, fetchOptionExpiries, findLeg } from "./etrade";
import { fetchMassiveOhlcDailyBars } from "./massive";
import { fetchDelayedQuotes, mapPool, YAHOO_CHART_BASE, YAHOO_UA } from "./quotes";
import type { CspCandidate, CspMark } from "./cspCycle";
import type { ShadowRow } from "./cspMath";
import { calendarDte, CSP_BS_RATE_FALLBACK, pickCspExpiry, resolvePutDelta, tbillAccrualCredit } from "./cspMath";
import {
  annualRateFromIrx,
  candidateFromChain,
  completedDailyBars,
  cspAtClose,
  cspScanDue,
  CSP_RECORDER_TOP_BETA,
  etYmd,
  markFromLeg,
  parseYahooEarningsCalendar,
  parseYahooOhlcDailyBars,
  recorderSymbols,
  selectCspSignals,
  snapshotRowsFromLegs,
  type CspDailyBar,
  type CspPendingSignal,
} from "./cspScan";
import { cspRecorderSlot } from "./cspCycle";
import {
  emptyCspState,
  insertCspSnapshots,
  loadCspShadows,
  loadCspState,
  saveCspState,
  type CspPersistedState,
} from "./cspStore";

const BAR_TTL_MS = 18 * 60 * 60 * 1000;
const RATE_TTL_MS = 6 * 60 * 60 * 1000;
const YAHOO_TIMEOUT_MS = 12_000;

const barCache = new Map<string, { at: number; bars: CspDailyBar[] }>();
let state: CspPersistedState = emptyCspState();
let stateLoaded = false;
let shadowsLoaded = false;
let rateCache: { at: number; rate: number } | null = null;
let lastAuthLog = "";
let scanInflight: Promise<void> | null = null;

function networkScanEnabled(): boolean {
  return (process.env.NODE_ENV || "").toLowerCase() !== "test";
}

type LogFn = (line: string) => void;
type PoolLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows?: unknown[]; rowCount?: number | null }>;
};
type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
};

export function resetCspLiveForTests(): void {
  barCache.clear();
  state = emptyCspState();
  stateLoaded = false;
  shadowsLoaded = false;
  rateCache = null;
  lastAuthLog = "";
  scanInflight = null;
}

export function cspPendingFor(symbol: string): CspPendingSignal | undefined {
  return state.pending.find((p) => p.symbol === symbol);
}

/** ^IRX when the network scan is on. Tests and a missing quote use the 0.04 fallback. */
export async function cspTbillRate(): Promise<number> {
  if (!networkScanEnabled()) return CSP_BS_RATE_FALLBACK;
  return tbillRate();
}

export function cspTbillAccruedUsd(): number {
  return state.tbillAccruedUsd;
}

export async function cspTbillAccruedForStatus(redis: RedisLike | null): Promise<number> {
  if (!stateLoaded) {
    state = await loadCspState(redis);
    stateLoaded = true;
  }
  return state.tbillAccruedUsd;
}

/**
 * Credit one T-bill day per America/New_York calendar date, including weekends
 * and holidays. The last date is stored on the csp Redis state so a restart
 * does not credit the same day again. A gap credits each missed day once.
 */
export async function accrueCspTbill(input: {
  now: Date;
  equityUsd: number;
  reservedUsd: number;
  assignedMvUsd: number;
  rate: number | null;
  redis: RedisLike | null;
  log: LogFn;
}): Promise<{ credited: number; accruedUsd: number; days: number; ymd: string; rate: number }> {
  if (!stateLoaded) {
    state = await loadCspState(input.redis);
    stateLoaded = true;
  }
  const today = etYmd(input.now);
  const planned = tbillAccrualCredit({
    equityUsd: input.equityUsd,
    reservedUsd: input.reservedUsd,
    assignedMvUsd: input.assignedMvUsd,
    annualRate: input.rate,
    lastYmd: state.tbillAccruedYmd,
    todayYmd: today,
  });
  if (planned.days <= 0) {
    return {
      credited: 0,
      accruedUsd: state.tbillAccruedUsd,
      days: 0,
      ymd: state.tbillAccruedYmd ?? today,
      rate: planned.rate,
    };
  }
  state = {
    ...state,
    tbillAccruedYmd: today,
    tbillAccruedUsd: Math.round((state.tbillAccruedUsd + planned.credit) * 100) / 100,
  };
  await saveCspState(input.redis, state);
  input.log(
    `[EventGate] csp tbill accrual days=${planned.days} rate=${planned.rate} base=${planned.base.toFixed(2)} credit=${planned.credit.toFixed(2)} (paper, not a broker credit)`,
  );
  return {
    credited: planned.credit,
    accruedUsd: state.tbillAccruedUsd,
    days: planned.days,
    ymd: today,
    rate: planned.rate,
  };
}

/** Drop the interest total when the csp sleeve book is reset. Other sleeves are untouched. */
export async function resetCspTbillAccrual(redis: RedisLike | null): Promise<void> {
  if (!stateLoaded) {
    state = await loadCspState(redis);
    stateLoaded = true;
  }
  if (state.tbillAccruedYmd === null && state.tbillAccruedUsd === 0) return;
  state = { ...state, tbillAccruedYmd: null, tbillAccruedUsd: 0 };
  await saveCspState(redis, state);
}

export async function noteCspFill(symbol: string, redis: RedisLike | null): Promise<void> {
  const before = state.pending.length;
  state.pending = state.pending.filter((p) => p.symbol !== symbol);
  if (state.pending.length !== before) await saveCspState(redis, state);
}

export interface CspTickPrep {
  candidates: CspCandidate[];
  marks: Record<string, CspMark>;
  atClose: boolean;
  chainAvailable: boolean;
  signals: string[];
  skips: Array<{ symbol: string; reason: string }>;
  recorder: { lastAt: string | null; rows: number; blocking: boolean; auth: string };
  /** Non-null only on the first successful load. */
  shadows: ShadowRow[] | null;
}

export async function prepareCspTick(input: {
  now: Date;
  positions: Position[];
  redis: RedisLike | null;
  pool: PoolLike | null;
  log: LogFn;
  recorder: { lastAt: string | null; rows: number; blocking: boolean; auth: string };
}): Promise<CspTickPrep> {
  const log = input.log;
  try {
    if (!stateLoaded) {
      state = await loadCspState(input.redis);
      stateLoaded = true;
    }
    let shadows: ShadowRow[] | null = null;
    if (!shadowsLoaded) {
      shadowsLoaded = true;
      shadows = await loadCspShadows(input.pool);
    }
    const today = etYmd(input.now);
    const pendingBefore = state.pending.length;
    state.pending = state.pending.filter((p) => p.tradeYmd >= today);
    if (networkScanEnabled() && cspScanDue(state.scannedAt, state.scannedYmd, input.now) && !scanInflight) {
      const redis = input.redis;
      const now = input.now;
      scanInflight = runScan(now, log)
        .then(() => saveCspState(redis, state))
        .catch((err) => {
          log(`[EventGate] csp scan failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          scanInflight = null;
        });
    } else if (state.pending.length !== pendingBefore) {
      await saveCspState(input.redis, state);
    }

    const auth = etradeAuthState();
    const chainAvailable = auth === "ok";
    const atClose = cspAtClose(input.now);
    const open = input.positions.filter((p) => p.side !== "Flat" && p.qty > 0 && p.csp && p.sleeveId === "csp");
    const openUnderlyings = new Set(open.map((p) => p.csp!.underlying));
    let recorder: CspTickPrep["recorder"] = { ...input.recorder, auth };
    let blocking = auth !== "ok";
    const skips: Array<{ symbol: string; reason: string }> = [];
    let candidates: CspCandidate[] = [];
    let marks: Record<string, CspMark> = {};

    if (!chainAvailable) {
      logAuthOnce(auth, log);
      recorder = { ...recorder, blocking: true, auth };
    } else {
      lastAuthLog = "";
      const priced = await collectEntryCandidates({
        now: input.now,
        pending: state.pending,
        openUnderlyings,
        rate: await tbillRate(),
        authOk: true,
        spot: spotOf,
        expiries: expiryDates,
        chain: chainLegs,
      });
      candidates = priced.candidates;
      skips.push(...priced.skips);
      blocking = priced.blocking;
      if (priced.blocking) {
        logAuthOnce(etradeAuthState(), log);
        recorder = { ...recorder, blocking: true, auth: etradeAuthState() };
      }
      marks = await marksForPuts(open, input.now, atClose, log);
      recorder = await maybeRecord(input.now, openUnderlyings, input.pool, log, recorder);
      await saveCspState(input.redis, state);
    }

    return {
      candidates,
      marks,
      atClose,
      chainAvailable: chainAvailable && !blocking,
      signals: state.pending.map((p) => `${p.symbol} signal ${p.signalYmd} for ${p.tradeYmd}`),
      skips,
      recorder,
      shadows,
    };
  } catch (err) {
    log(`[EventGate] csp tick failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      candidates: [],
      marks: {},
      atClose: cspAtClose(input.now),
      chainAvailable: false,
      signals: state.pending.map((p) => `${p.symbol} signal ${p.signalYmd} for ${p.tradeYmd}`),
      skips: [{ symbol: "csp", reason: "tick failed" }],
      recorder: { ...input.recorder, blocking: true },
      shadows: null,
    };
  }
}

export async function collectEntryCandidates(input: {
  now: Date;
  pending: CspPendingSignal[];
  openUnderlyings: Set<string>;
  rate: number;
  authOk: boolean;
  spot: (symbol: string) => Promise<number | null>;
  expiries: (symbol: string) => Promise<{ ok: true; dates: string[] } | { ok: false; error: string }>;
  chain: (symbol: string, expiry: string) => Promise<{ ok: true; legs: OptionLeg[] } | { ok: false; error: string }>;
}): Promise<{
  candidates: CspCandidate[];
  skips: Array<{ symbol: string; reason: string }>;
  blocking: boolean;
}> {
  const skips: Array<{ symbol: string; reason: string }> = [];
  const candidates: CspCandidate[] = [];
  if (!input.authOk) {
    return { candidates, skips: [{ symbol: "csp", reason: "E*TRADE chain unavailable" }], blocking: true };
  }
  const today = etYmd(input.now);
  let blocking = false;
  for (const sig of input.pending) {
    if (sig.tradeYmd !== today) continue;
    if (input.openUnderlyings.has(sig.symbol)) {
      skips.push({ symbol: sig.symbol, reason: "already open" });
      continue;
    }
    const exp = await input.expiries(sig.symbol);
    if (!exp.ok) {
      if (isPinError(exp.error)) {
        blocking = true;
        skips.push({ symbol: sig.symbol, reason: "E*TRADE needs PIN" });
        break;
      }
      skips.push({ symbol: sig.symbol, reason: exp.error });
      continue;
    }
    const picked = pickCspExpiry(exp.dates, today);
    if (!picked) {
      skips.push({ symbol: sig.symbol, reason: "no 35–50 DTE expiry" });
      continue;
    }
    const spot = await input.spot(sig.symbol);
    if (spot === null) {
      skips.push({ symbol: sig.symbol, reason: "no underlying last" });
      continue;
    }
    const chain = await input.chain(sig.symbol, picked.expiry);
    if (!chain.ok) {
      if (isPinError(chain.error)) {
        blocking = true;
        skips.push({ symbol: sig.symbol, reason: "E*TRADE needs PIN" });
        break;
      }
      skips.push({ symbol: sig.symbol, reason: chain.error });
      continue;
    }
    const built = candidateFromChain({
      symbol: sig.symbol,
      expiries: exp.dates,
      legs: chain.legs,
      spot,
      asOfYmd: today,
      rate: input.rate,
      earnings: sig.earnings,
    });
    if (!built.candidate) {
      skips.push({ symbol: sig.symbol, reason: built.skip ?? "no contract" });
      continue;
    }
    candidates.push(built.candidate);
  }
  return { candidates, skips, blocking };
}

async function runScan(now: Date, log: LogFn): Promise<void> {
  log(`[EventGate] csp scan start universe=${CSP_UNIVERSE.length}`);
  const spyRaw = await fetchBars("SPY", "SPY");
  if (!spyRaw) {
    log("[EventGate] csp scan skip: SPY daily bars unavailable");
    return;
  }
  const spy = completedDailyBars(spyRaw, now);
  const names: Array<{ symbol: string; bars: CspDailyBar[] }> = [];
  await mapPool([...CSP_UNIVERSE], 4, async (name) => {
    try {
      const raw = await fetchBars(name.symbol, name.yahoo);
      if (!raw) return;
      const bars = completedDailyBars(raw, now);
      if (bars.length >= 80) names.push({ symbol: name.symbol, bars });
    } catch (err) {
      log(`[EventGate] csp bars skip ${name.symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  if (names.length < 20) {
    log(`[EventGate] csp scan incomplete names=${names.length}; will retry`);
    return;
  }
  const prelim = selectCspSignals({ names, spy, earningsBySymbol: new Map(), now });
  const earningsBySymbol = new Map<string, string[] | null>();
  await mapPool(prelim.pending, 4, async (sig) => {
    const yahoo = CSP_UNIVERSE.find((n) => n.symbol === sig.symbol)?.yahoo ?? sig.symbol;
    try {
      earningsBySymbol.set(sig.symbol, await fetchEarnings(yahoo));
    } catch {
      earningsBySymbol.set(sig.symbol, null);
    }
    await sleep(150);
  });
  const selected = selectCspSignals({ names, spy, earningsBySymbol, now });
  state = {
    ...state,
    scannedAt: now.toISOString(),
    scannedYmd: etYmd(now),
    pending: selected.pending,
    ranked: selected.ranked.slice(0, 80),
  };
  const highBeta = selected.ranked.filter((r) => r.beta > 1.3).length;
  log(
    `[EventGate] csp scan done names=${names.length} highBeta=${highBeta} signals=${selected.pending.length} trade=${selected.pending[0]?.tradeYmd ?? "none"}`,
  );
}

async function marksForPuts(
  open: Position[],
  now: Date,
  atClose: boolean,
  log: LogFn,
): Promise<Record<string, CspMark>> {
  const marks: Record<string, CspMark> = {};
  if (open.length === 0) return marks;
  const rate = await tbillRate();
  let spyClose: number | null = null;
  let spySma200: number | null = null;
  if (atClose) {
    const spy = await fetchBars("SPY", "SPY");
    const done = spy ? completedDailyBars(spy, now) : [];
    if (done.length) {
      spyClose = done[done.length - 1].close;
      if (done.length >= 200) {
        const slice = done.slice(-200);
        spySma200 = slice.reduce((s, b) => s + b.close, 0) / slice.length;
      }
    }
  }
  const groups = new Map<string, { underlying: string; expiry: string }>();
  for (const p of open) {
    const meta = p.csp!;
    groups.set(`${meta.underlying}|${meta.expiry}`, { underlying: meta.underlying, expiry: meta.expiry });
  }
  const legsByKey = new Map<string, OptionLeg[]>();
  for (const [key, g] of groups) {
    if (etradeAuthState() !== "ok") break;
    const chain = await chainLegs(g.underlying, g.expiry);
    if (!chain.ok) {
      if (isPinError(chain.error)) {
        logAuthOnce("needs_pin", log);
        break;
      }
      log(`[EventGate] csp mark skip ${g.underlying} ${g.expiry}: ${chain.error}`);
      continue;
    }
    legsByKey.set(key, chain.legs);
    await sleep(250);
  }
  for (const p of open) {
    const meta = p.csp!;
    const key = `${meta.underlying}|${meta.expiry}`;
    const legs = legsByKey.get(key) ?? [];
    const leg = findLeg(legs, { strike: meta.strike, right: "P", expiry: meta.expiry }) ?? null;
    const spot = await spotOf(meta.underlying);
    const dte = calendarDte(etYmd(now), meta.expiry);
    const delta =
      leg?.delta ??
      (leg && spot !== null
        ? resolvePutDelta({ strike: leg.strike, delta: null, iv: leg.iv }, spot, dte ?? 45, rate)?.delta ?? null
        : null);
    const resolved = markFromLeg({
      leg: leg ? { ...leg, delta } : null,
      spot,
      underlyingClose: atClose ? spot ?? null : null,
      spyClose: atClose ? spyClose : null,
      spySma200: atClose ? spySma200 : null,
      dte,
    });
    marks[p.id] = resolved;
  }
  return marks;
}

async function maybeRecord(
  now: Date,
  openUnderlyings: Set<string>,
  pool: PoolLike | null,
  log: LogFn,
  recorder: CspTickPrep["recorder"],
): Promise<CspTickPrep["recorder"]> {
  const slot = cspRecorderSlot(now);
  if (!slot) return { ...recorder, auth: etradeAuthState(), blocking: etradeAuthState() !== "ok" };
  const key = `${etYmd(now)}:${slot}`;
  if (state.recorderSlots.includes(key)) return recorder;
  if (etradeAuthState() !== "ok") {
    logAuthOnce(etradeAuthState(), log);
    return { ...recorder, blocking: true, auth: etradeAuthState() };
  }
  const symbols = recorderSymbols(
    state.pending.map((p) => p.symbol),
    [...openUnderlyings],
    state.ranked,
    CSP_RECORDER_TOP_BETA,
  );
  log(`[EventGate] csp recorder ${slot} symbols=${symbols.length}`);
  const rate = await tbillRate();
  const rows = [];
  let blocking = false;
  for (const symbol of symbols) {
    if (etradeAuthState() !== "ok") {
      blocking = true;
      logAuthOnce("needs_pin", log);
      break;
    }
    try {
      const exp = await expiryDates(symbol);
      if (!exp.ok) {
        if (isPinError(exp.error)) {
          blocking = true;
          logAuthOnce("needs_pin", log);
          break;
        }
        log(`[EventGate] csp recorder skip ${symbol}: ${exp.error}`);
        await sleep(250);
        continue;
      }
      const spot = await spotOf(symbol);
      const today = etYmd(now);
      const band = exp.dates
        .map((expiry) => ({ expiry, dte: calendarDte(today, expiry) }))
        .filter((row) => row.dte !== null && row.dte >= 25 && row.dte <= 60)
        .slice(0, 6);
      for (const item of band) {
        const chain = await chainLegs(symbol, item.expiry);
        if (!chain.ok) {
          if (isPinError(chain.error)) {
            blocking = true;
            break;
          }
          continue;
        }
        rows.push(...snapshotRowsFromLegs(symbol, spot, chain.legs, today, rate));
      }
      if (blocking) {
        logAuthOnce("needs_pin", log);
        break;
      }
    } catch (err) {
      log(`[EventGate] csp recorder skip ${symbol}: ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(250);
  }
  if (blocking && rows.length === 0) {
    return { ...recorder, blocking: true, auth: etradeAuthState() };
  }
  const written = await insertCspSnapshots(pool, now.toISOString(), rows);
  state.recorderSlots = [...state.recorderSlots, key].slice(-8);
  log(`[EventGate] csp recorder ${slot} rows=${written}`);
  return {
    lastAt: `${now.toISOString()} ${slot}`,
    rows: written,
    blocking: false,
    auth: "ok",
  };
}

async function fetchBars(symbol: string, yahoo: string): Promise<CspDailyBar[] | null> {
  const hit = barCache.get(symbol);
  if (hit && Date.now() - hit.at < BAR_TTL_MS) return hit.bars;
  let bars: CspDailyBar[] | null = null;
  try {
    const massive = await fetchMassiveOhlcDailyBars(symbol);
    if (massive && massive.length >= 80) bars = massive;
  } catch {
    bars = null;
  }
  if (!bars) {
    bars = await fetchYahooDaily(yahoo);
    await sleep(200);
  }
  if (bars && bars.length) barCache.set(symbol, { at: Date.now(), bars });
  return bars;
}

async function fetchYahooDaily(yahoo: string): Promise<CspDailyBar[] | null> {
  const url = `${YAHOO_CHART_BASE}${encodeURIComponent(yahoo)}?interval=1d&range=2y`;
  const body = await yahooGet(url);
  if (!body) return null;
  return parseYahooOhlcDailyBars(body);
}

async function fetchEarnings(yahoo: string): Promise<string[] | null> {
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahoo)}?modules=calendarEvents`;
  const body = await yahooGet(url);
  if (!body) return null;
  return parseYahooEarningsCalendar(body);
}

async function tbillRate(): Promise<number> {
  if (rateCache && Date.now() - rateCache.at < RATE_TTL_MS) return rateCache.rate;
  const url = `${YAHOO_CHART_BASE}${encodeURIComponent("^IRX")}?interval=1d&range=5d`;
  const body = await yahooGet(url);
  let last: number | null = null;
  const root = body && typeof body === "object" ? (body as { chart?: { result?: Array<{ meta?: { regularMarketPrice?: number } }> } }) : null;
  const price = root?.chart?.result?.[0]?.meta?.regularMarketPrice;
  if (typeof price === "number" && Number.isFinite(price)) last = price;
  const rate = annualRateFromIrx(last);
  rateCache = { at: Date.now(), rate };
  return rate;
}

async function yahooGet(url: string): Promise<unknown | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), YAHOO_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { "User-Agent": YAHOO_UA }, signal: ac.signal });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function spotOf(symbol: string): Promise<number | null> {
  try {
    const quotes = await fetchDelayedQuotes([symbol]);
    const last = quotes[0]?.last;
    return typeof last === "number" && last > 0 ? last : null;
  } catch {
    return null;
  }
}

async function expiryDates(
  symbol: string,
): Promise<{ ok: true; dates: string[] } | { ok: false; error: string }> {
  const got = await fetchOptionExpiries(symbol);
  if (!got.ok) return { ok: false, error: got.error };
  return { ok: true, dates: got.data.expiries.map((e) => e.expiry) };
}

async function chainLegs(
  symbol: string,
  expiry: string,
): Promise<{ ok: true; legs: OptionLeg[] } | { ok: false; error: string }> {
  const got = await fetchOptionChain({ symbol, expiry, noOfStrikes: 40 });
  if (!got.ok) return { ok: false, error: got.error };
  return { ok: true, legs: got.data.legs };
}

function isPinError(error: string): boolean {
  return /401|needs_pin|PIN/i.test(error) || etradeAuthState() === "needs_pin";
}

function logAuthOnce(auth: string, log: LogFn): void {
  const line = `[EventGate] csp chain skip: E*TRADE auth ${auth} (no crash, no order)`;
  if (line === lastAuthLog) return;
  lastAuthLog = line;
  log(line);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
