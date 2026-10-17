import path from "node:path";
import { etParts, pad2 } from "../../shared/clock";
import type {
  DelayedQuote,
  OptionChainSnapshot,
  OptionExpiry,
  OptionExpiriesResponse,
  OptionLeg,
  OptionRight,
} from "../../shared/types";
import type { MinuteBar } from "./dayMomentum";
import { loadEnvFile, parseYmd, type ChainQuery } from "./etrade";

export const MASSIVE_BASE = "https://api.massive.com";
export const MASSIVE_UA = "EventGate/1.0";
export const MASSIVE_CACHE_MS = 45_000;
export const MASSIVE_FETCH_TIMEOUT_MS = 12_000;
export const MASSIVE_PAGE_LIMIT = 250;
const MAX_PAGES = 20;
const AGG_LOOKBACK_DAYS = 420;

export type DailyBar = { close: number; volume: number };

/** Cash distribution from Massive. Missing cash_amount is not represented. */
export type MassiveCashDividend = {
  ticker: string;
  exDate: string;
  cashAmount: number;
};

type CacheEntry<T> = { at: number; value: T };
const expiryCache = new Map<string, CacheEntry<OptionExpiriesResponse>>();
const chainCache = new Map<string, CacheEntry<OptionChainSnapshot>>();
const aggCache = new Map<string, CacheEntry<DailyBar[] | null>>();
const ohlcCache = new Map<string, CacheEntry<MassiveOhlcBar[] | null>>();
const dividendCache = new Map<string, CacheEntry<MassiveCashDividend[] | null>>();

export function resetMassiveCache(): void {
  expiryCache.clear();
  chainCache.clear();
  aggCache.clear();
  ohlcCache.clear();
  dividendCache.clear();
  futuresContractCache.clear();
  futuresAggCache.clear();
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

/** Fill unset keys from .env. Never logs values. Skipped in tests. */
export function maybeLoadAppDotenv(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.NODE_ENV || "").toLowerCase() === "test") return;
  const cwd = process.cwd();
  for (const f of [path.resolve(cwd, ".env"), path.resolve(cwd, "..", ".env")]) {
    loadEnvFile(f, env);
  }
}

/** Returns the key or undefined. Never logs it. */
export function massiveApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  maybeLoadAppDotenv(env);
  const k = env.MASSIVE_API_KEY;
  if (typeof k !== "string") return undefined;
  const t = k.trim();
  return t.length ? t : undefined;
}

export function massiveConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(massiveApiKey(env));
}

export const MASSIVE_KEY_MISSING =
  "MASSIVE_API_KEY missing. Equities need Massive Stocks Starter (15-min delayed). Futures fall back to Yahoo.";

/** CME product codes Massive Futures documents (dated tickers like MESU6, not F:MES or MES=F). */
export const MASSIVE_FUTURES_PRODUCT_BY_ROOT: Record<string, string> = {
  MES: "MES",
  MNQ: "MNQ",
  ES: "ES",
  NQ: "NQ",
  ZN: "ZN",
  ZF: "ZF",
  ZT: "ZT",
  ZB: "ZB",
  SR3: "SR3",
  "6E": "6E",
  M6E: "M6E",
};

export type FuturesContractRow = {
  ticker: string;
  productCode: string;
  active: boolean | null;
  type: string | null;
  daysToMaturity: number | null;
  settlementDate: string | null;
  lastTradeDate: string | null;
};

const futuresContractCache = new Map<string, CacheEntry<FuturesContractRow | null>>();
const futuresAggCache = new Map<string, CacheEntry<MinuteBar[] | null>>();

/** US equity/ETF underlyer for option chains. Reject empty, futures, OSI keys. */
export function parseOptionsUnderlying(
  raw: string,
): { ok: true; symbol: string } | { ok: false; error: string } {
  const t = raw.trim().toUpperCase();
  if (!t) return { ok: false, error: "symbol required" };
  if (t.includes("=") || /=(F)?$/.test(t)) {
    return { ok: false, error: "futures not supported for options chains" };
  }
  const osi = t.startsWith("O:") ? t.slice(2) : t;
  if (t.startsWith("O:") || /\d{6}[CP]\d{8}$/.test(osi.replace(/[^A-Z0-9]/g, ""))) {
    return { ok: false, error: "option OSI keys refused; pass the underlyer (e.g. AAPL)" };
  }
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(t)) {
    return { ok: false, error: "US equity/ETF ticker required" };
  }
  return { ok: true, symbol: t };
}

function stripApiKeyFromUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete("apiKey");
    u.searchParams.delete("apikey");
    u.searchParams.delete("api_key");
    return u.toString();
  } catch {
    return url;
  }
}

function authHeaders(key: string): Record<string, string> {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${key}`,
    "User-Agent": MASSIVE_UA,
  };
}

async function massiveGetJson(
  url: string,
  key: string,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  const href = stripApiKeyFromUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), MASSIVE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(href, {
      method: "GET",
      headers: authHeaders(key),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status === 401 || res.status === 403 ? 503 : 502,
        error: `Massive API ${res.status}`,
      };
    }
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, status: 502, error: "Massive API returned non-JSON" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `Massive API unreachable (${msg})` };
  } finally {
    clearTimeout(timer);
  }
}

function ymdUtc(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nsToIso(ns: number | null): string | null {
  if (ns === null || !Number.isFinite(ns) || ns <= 0) return null;
  const ms = ns > 1e15 ? ns / 1e6 : ns > 1e12 ? ns / 1e3 : ns;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function parseMassiveSnapshotQuote(symbol: string, body: unknown): DelayedQuote {
  const root = asRecord(body);
  const ticker = asRecord(root?.ticker);
  if (!ticker) {
    return {
      symbol,
      last: null,
      prevClose: null,
      change: null,
      changePct: null,
      asOf: null,
      exchange: null,
      delayed: true,
      source: "massive",
      error: "no ticker snapshot",
    };
  }
  const lastTrade = asRecord(ticker.lastTrade);
  const day = asRecord(ticker.day);
  const prevDay = asRecord(ticker.prevDay);
  const lastQuote = asRecord(ticker.lastQuote);
  const last =
    num(lastTrade?.p) ??
    num(day?.c) ??
    num(lastQuote?.P) ??
    num(lastQuote?.p);
  if (last === null) {
    return {
      symbol: str(ticker.ticker) ?? symbol,
      last: null,
      prevClose: num(prevDay?.c),
      change: null,
      changePct: null,
      asOf: nsToIso(num(ticker.updated)),
      exchange: null,
      delayed: true,
      source: "massive",
      error: "no last trade/close",
    };
  }
  const prevClose = num(prevDay?.c);
  const change = num(ticker.todaysChange) ?? (prevClose !== null ? last - prevClose : null);
  const changePct =
    num(ticker.todaysChangePerc) ??
    (change !== null && prevClose !== null && prevClose !== 0 ? (change / prevClose) * 100 : null);
  return {
    symbol: str(ticker.ticker) ?? symbol,
    last,
    prevClose,
    change,
    changePct,
    asOf: nsToIso(num(lastTrade?.t) ?? num(ticker.updated)),
    exchange: null,
    delayed: true,
    source: "massive",
  };
}

export function parseMassiveDailyBars(body: unknown): DailyBar[] | null {
  const root = asRecord(body);
  const results = root?.results;
  if (!Array.isArray(results)) return null;
  const bars: DailyBar[] = [];
  for (const row of results) {
    const r = asRecord(row);
    if (!r) continue;
    const c = num(r.c);
    if (c === null) continue;
    const v = num(r.v);
    bars.push({ close: c, volume: v !== null ? v : 0 });
  }
  return bars.length ? bars : null;
}

export async function fetchMassiveQuote(symbol: string): Promise<DelayedQuote> {
  const key = massiveApiKey();
  if (!key) {
    return {
      symbol,
      last: null,
      prevClose: null,
      change: null,
      changePct: null,
      asOf: null,
      exchange: null,
      delayed: true,
      source: "massive",
      error: MASSIVE_KEY_MISSING,
    };
  }
  const url = `${MASSIVE_BASE}/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol)}`;
  const got = await massiveGetJson(url, key);
  if (!got.ok) {
    return {
      symbol,
      last: null,
      prevClose: null,
      change: null,
      changePct: null,
      asOf: null,
      exchange: null,
      delayed: true,
      source: "massive",
      error: got.error,
    };
  }
  return parseMassiveSnapshotQuote(symbol, got.body);
}

export type MassiveOhlcBar = {
  /** Trading date from the aggregate timestamp (UTC calendar day). */
  ymd: string;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** Daily OHLC. Rows missing high, low, close, or a timestamp are dropped. */
export function parseMassiveOhlcDailyBars(body: unknown): MassiveOhlcBar[] | null {
  const root = asRecord(body);
  const results = root?.results;
  if (!Array.isArray(results)) return null;
  const bars: MassiveOhlcBar[] = [];
  for (const row of results) {
    const r = asRecord(row);
    if (!r) continue;
    const t = num(r.t);
    const high = num(r.h);
    const low = num(r.l);
    const close = num(r.c);
    if (t === null || high === null || low === null || close === null) continue;
    const ms = t > 1e12 ? t : t * 1000;
    const ymd = new Date(ms).toISOString().slice(0, 10);
    const volume = num(r.v);
    bars.push({ ymd, high, low, close, volume: volume !== null ? volume : 0 });
  }
  return bars.length ? bars : null;
}

export async function fetchMassiveOhlcDailyBars(ticker: string): Promise<MassiveOhlcBar[] | null> {
  const key = massiveApiKey();
  if (!key) return null;
  const now = Date.now();
  const hit = ohlcCache.get(ticker);
  if (hit && now - hit.at < MASSIVE_CACHE_MS) return hit.value;
  const to = new Date(now);
  const from = new Date(now - AGG_LOOKBACK_DAYS * 86_400_000);
  const url =
    `${MASSIVE_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${ymdUtc(from)}/${ymdUtc(to)}` +
    `?adjusted=true&sort=asc&limit=50000`;
  const got = await massiveGetJson(url, key);
  if (!got.ok) {
    ohlcCache.set(ticker, { at: now, value: null });
    return null;
  }
  const bars = parseMassiveOhlcDailyBars(got.body);
  ohlcCache.set(ticker, { at: now, value: bars });
  return bars;
}

export async function fetchMassiveDailyBars(ticker: string): Promise<DailyBar[] | null> {
  const key = massiveApiKey();
  if (!key) return null;
  const now = Date.now();
  const hit = aggCache.get(ticker);
  if (hit && now - hit.at < MASSIVE_CACHE_MS) return hit.value;
  const to = new Date(now);
  const from = new Date(now - AGG_LOOKBACK_DAYS * 86_400_000);
  const url =
    `${MASSIVE_BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${ymdUtc(from)}/${ymdUtc(to)}` +
    `?adjusted=true&sort=asc&limit=50000`;
  // adjusted=true is split adjustment only. Massive does not dividend-adjust
  // aggregate closes, so close/close returns are not total returns.
  const got = await massiveGetJson(url, key);
  if (!got.ok) {
    aggCache.set(ticker, { at: now, value: null });
    return null;
  }
  const bars = parseMassiveDailyBars(got.body);
  aggCache.set(ticker, { at: now, value: bars });
  return bars;
}

/**
 * Parse Massive cash dividends. Accepts `/stocks/v1/dividends` and the older
 * `/v3/reference/dividends` shape (`results[].cash_amount`, `ex_dividend_date`).
 * Rows without a positive USD cash amount or an ex-date are dropped. A body
 * that is not a results array is null (caller must not invent a credit).
 */
export function parseMassiveCashDividends(body: unknown): MassiveCashDividend[] | null {
  const root = asRecord(body);
  if (!root || !Array.isArray(root.results)) return null;
  const out: MassiveCashDividend[] = [];
  for (const row of root.results) {
    const r = asRecord(row);
    if (!r) continue;
    const ticker = str(r.ticker);
    const exDate = str(r.ex_dividend_date);
    const cash = num(r.cash_amount);
    if (!ticker || !exDate || !/^\d{4}-\d{2}-\d{2}$/.test(exDate)) continue;
    if (cash === null || !(cash > 0)) continue;
    const currency = str(r.currency);
    if (currency && currency.toUpperCase() !== "USD") continue;
    out.push({ ticker: ticker.toUpperCase(), exDate, cashAmount: cash });
  }
  return out;
}

/**
 * Cash dividends for one ticker. Null when the key is missing or both
 * Massive dividend routes fail — callers credit nothing. Empty array means
 * the endpoint answered and listed no usable cash rows.
 */
export async function fetchMassiveCashDividends(
  ticker: string,
  exDate?: string,
): Promise<MassiveCashDividend[] | null> {
  const key = massiveApiKey();
  if (!key) return null;
  const symbol = ticker.trim().toUpperCase();
  if (!symbol) return null;
  const cacheKey = exDate ? `${symbol}|${exDate}` : symbol;
  const now = Date.now();
  const hit = dividendCache.get(cacheKey);
  if (hit && now - hit.at < MASSIVE_CACHE_MS) return hit.value;
  const params = new URLSearchParams({
    ticker: symbol,
    limit: "20",
    sort: "ex_dividend_date.desc",
  });
  if (exDate) params.set("ex_dividend_date", exDate);
  const q = params.toString();
  const urls = [
    `${MASSIVE_BASE}/stocks/v1/dividends?${q}`,
    `${MASSIVE_BASE}/v3/reference/dividends?${q}`,
  ];
  let parsed: MassiveCashDividend[] | null = null;
  for (const url of urls) {
    const got = await massiveGetJson(url, key);
    if (!got.ok) continue;
    const rows = parseMassiveCashDividends(got.body);
    if (rows === null) continue;
    parsed = rows;
    break;
  }
  dividendCache.set(cacheKey, { at: now, value: parsed });
  return parsed;
}

/** Display MES=F / F:MES / MES → Massive product_code MES. Unknown =F roots stay unmapped. */
export function massiveFuturesProductCode(symbol: string): string | null {
  const raw = symbol.trim().toUpperCase();
  if (!raw) return null;
  const stripped = raw.replace(/^F:/, "").replace(/=F$/, "");
  return MASSIVE_FUTURES_PRODUCT_BY_ROOT[stripped] ?? null;
}

export function parseMassiveFuturesContracts(body: unknown): FuturesContractRow[] {
  const root = asRecord(body);
  const out: FuturesContractRow[] = [];
  for (const row of asArray(root?.results)) {
    const r = asRecord(row);
    if (!r) continue;
    const ticker = str(r.ticker);
    if (!ticker) continue;
    const productCode = str(r.product_code) ?? "";
    const type = str(r.type);
    const active = typeof r.active === "boolean" ? r.active : null;
    out.push({
      ticker,
      productCode,
      active,
      type,
      daysToMaturity: num(r.days_to_maturity),
      settlementDate: str(r.settlement_date),
      lastTradeDate: str(r.last_trade_date),
    });
  }
  return out;
}

/**
 * Nearest active outright. Massive has no continuous F: ticker.
 * `asOfYmd` is the ET session date: a contract whose last trade (or
 * settlement) is already past that date is not the front month, even if a
 * stale `days_to_maturity` is still positive. That is the September 2026
 * MESU6 → MESZ6 roll.
 */
export function pickFrontMonthContract(
  rows: FuturesContractRow[],
  asOfYmd?: string,
): FuturesContractRow | null {
  const eligible = rows.filter((r) => {
    if (!r.ticker || r.ticker.includes("-")) return false;
    if (r.active === false) return false;
    if (r.type && r.type.toLowerCase() !== "single") return false;
    if (r.daysToMaturity !== null && r.daysToMaturity < 0) return false;
    const expiry = r.lastTradeDate ?? r.settlementDate;
    if (asOfYmd && expiry && expiry < asOfYmd) return false;
    return true;
  });
  eligible.sort((a, b) => {
    const da = a.daysToMaturity;
    const db = b.daysToMaturity;
    if (da !== null && db !== null && da !== db) return da - db;
    if (da !== null && db === null) return -1;
    if (da === null && db !== null) return 1;
    const sa = a.settlementDate ?? a.lastTradeDate ?? "";
    const sb = b.settlementDate ?? b.lastTradeDate ?? "";
    if (sa && sb && sa !== sb) return sa.localeCompare(sb);
    return a.ticker.localeCompare(b.ticker);
  });
  return eligible[0] ?? null;
}

function windowStartToMs(raw: number): number | null {
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const ms = raw > 1e15 ? raw / 1e6 : raw > 1e12 ? raw / 1e3 : raw;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : ms;
}

export function parseMassiveFuturesAggs(body: unknown): MinuteBar[] {
  const root = asRecord(body);
  const results = root?.results;
  if (!Array.isArray(results)) return [];
  const bars: MinuteBar[] = [];
  for (const row of results) {
    const r = asRecord(row);
    if (!r) continue;
    const o = num(r.open ?? r.o);
    const h = num(r.high ?? r.h);
    const l = num(r.low ?? r.l);
    const c = num(r.close ?? r.c);
    const t = num(r.window_start ?? r.t);
    if (o === null || h === null || l === null || c === null || t === null) continue;
    const ts = windowStartToMs(t);
    if (ts === null) continue;
    const v = num(r.volume ?? r.v);
    bars.push({
      ts,
      open: o,
      high: h,
      low: l,
      close: c,
      volume: v !== null ? v : 0,
    });
  }
  bars.sort((a, b) => a.ts - b.ts);
  return bars;
}

export function parseMassiveFuturesSnapshotQuote(displaySymbol: string, body: unknown): DelayedQuote {
  const root = asRecord(body);
  const results = asArray(root?.results);
  let picked: Record<string, unknown> | null = null;
  for (const row of results) {
    const r = asRecord(row);
    if (r) {
      picked = r;
      break;
    }
  }
  if (!picked) {
    const ticker = asRecord(root?.ticker);
    picked = ticker ?? root;
  }
  if (!picked) {
    return {
      symbol: displaySymbol,
      last: null,
      prevClose: null,
      change: null,
      changePct: null,
      asOf: null,
      exchange: null,
      delayed: true,
      source: "massive",
      error: "no futures snapshot",
    };
  }
  const lastTrade = asRecord(picked.last_trade) ?? asRecord(picked.lastTrade);
  const session = asRecord(picked.session);
  const lastMinute = asRecord(picked.last_minute) ?? asRecord(picked.lastMinute);
  const last =
    num(lastTrade?.price ?? lastTrade?.p) ??
    num(session?.close ?? session?.c) ??
    num(lastMinute?.close ?? lastMinute?.c);
  const prevClose = num(session?.previous_settlement ?? session?.prevClose);
  if (last === null) {
    return {
      symbol: displaySymbol,
      last: null,
      prevClose,
      change: null,
      changePct: null,
      asOf: nsToIso(num(lastTrade?.last_updated ?? lastTrade?.t ?? picked.updated)),
      exchange: str(picked.ticker),
      delayed: true,
      source: "massive",
      error: "no futures last trade/close",
    };
  }
  const change =
    num(session?.change) ?? (prevClose !== null ? last - prevClose : null);
  const rawPct = num(session?.change_percent ?? session?.changePercent);
  const changePct =
    rawPct !== null
      ? Math.abs(rawPct) <= 1 && prevClose !== null && prevClose !== 0
        ? rawPct * 100
        : rawPct
      : change !== null && prevClose !== null && prevClose !== 0
        ? (change / prevClose) * 100
        : null;
  return {
    symbol: displaySymbol,
    last,
    prevClose,
    change,
    changePct,
    asOf: nsToIso(num(lastTrade?.last_updated ?? lastTrade?.timestamp ?? lastTrade?.t)),
    exchange: str(picked.ticker),
    delayed: true,
    source: "massive",
  };
}

function etSessionYmd(now: Date): string {
  const p = etParts(now);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

const FRONT_MONTH_PAGES = 3;

export async function resolveMassiveFrontMonth(
  productCode: string,
): Promise<{ contract: FuturesContractRow | null; error?: string }> {
  const key = massiveApiKey();
  if (!key) return { contract: null, error: MASSIVE_KEY_MISSING };
  const code = productCode.trim().toUpperCase();
  if (!code) return { contract: null, error: "missing futures product code" };
  const now = Date.now();
  const asOf = etSessionYmd(new Date(now));
  const cacheKey = `${code}|${asOf}`;
  const hit = futuresContractCache.get(cacheKey);
  if (hit && now - hit.at < MASSIVE_CACHE_MS) {
    return hit.value
      ? { contract: hit.value }
      : { contract: null, error: `no Massive front-month for ${code} as of ${asOf}` };
  }
  // `date` is the point-in-time session. Without it, `active=true` is not
  // "tradeable today", and days_to_maturity.asc can fill the page with
  // expired MESU6 rows after the September roll so MESZ6 never appears.
  let url: string | null =
    `${MASSIVE_BASE}/futures/v1/contracts?product_code=${encodeURIComponent(code)}` +
    `&date=${asOf}&active=true&type=single&last_trade_date.gte=${asOf}` +
    `&limit=100&sort=days_to_maturity.asc`;
  const rows: FuturesContractRow[] = [];
  for (let page = 0; page < FRONT_MONTH_PAGES && url; page++) {
    const got = await massiveGetJson(url, key);
    if (!got.ok) {
      if (page === 0) futuresContractCache.set(cacheKey, { at: now, value: null });
      return { contract: null, error: got.error };
    }
    rows.push(...parseMassiveFuturesContracts(got.body));
    const picked = pickFrontMonthContract(rows, asOf);
    if (picked) {
      futuresContractCache.set(cacheKey, { at: now, value: picked });
      return { contract: picked };
    }
    const next = str(asRecord(got.body)?.next_url);
    url = next ? stripApiKeyFromUrl(next) : null;
  }
  futuresContractCache.set(cacheKey, { at: now, value: null });
  return { contract: null, error: `no Massive front-month for ${code} as of ${asOf}` };
}

export async function fetchMassiveFuturesQuote(displaySymbol: string): Promise<DelayedQuote> {
  const product = massiveFuturesProductCode(displaySymbol);
  const missing = {
    symbol: displaySymbol,
    last: null as number | null,
    prevClose: null as number | null,
    change: null as number | null,
    changePct: null as number | null,
    asOf: null as string | null,
    exchange: null as string | null,
    delayed: true as const,
    source: "massive" as const,
  };
  const key = massiveApiKey();
  if (!key) return { ...missing, error: MASSIVE_KEY_MISSING };
  if (!product) return { ...missing, error: `no Massive futures product for ${displaySymbol}` };
  const lookedUp = await resolveMassiveFrontMonth(product);
  const front = lookedUp.contract;
  if (!front) return { ...missing, error: lookedUp.error ?? `no Massive front-month for ${product}` };
  const url = `${MASSIVE_BASE}/futures/v1/snapshot?ticker=${encodeURIComponent(front.ticker)}&limit=1`;
  const got = await massiveGetJson(url, key);
  if (!got.ok) return { ...missing, error: got.error };
  return parseMassiveFuturesSnapshotQuote(displaySymbol, got.body);
}

export type MassiveFuturesBarsResult = {
  bars: MinuteBar[];
  ticker?: string;
  error?: string;
};

export type MassiveFuturesBarsQuery = {
  /**
   * Calendar days before now for `window_start.gte`. Default 2 keeps the
   * day-sleeve stochastic query (oldest-first). The fade passes a longer
   * lookback so the prior cash close survives a weekend or a holiday.
   */
  lookbackDays?: number;
  /**
   * Default `asc` (stochastic). The fade uses `desc` so `limit=1000` keeps
   * the newest bars — today's session and the prior close — instead of the
   * oldest bars in a multi-day window.
   */
  sort?: "asc" | "desc";
};

export async function fetchMassiveFuturesFiveMinuteBars(
  productCode = "MES",
  query?: MassiveFuturesBarsQuery,
): Promise<MassiveFuturesBarsResult> {
  const key = massiveApiKey();
  if (!key) return { bars: [], error: MASSIVE_KEY_MISSING };
  const code = productCode.trim().toUpperCase();
  const lookedUp = await resolveMassiveFrontMonth(code);
  const front = lookedUp.contract;
  if (!front) return { bars: [], error: lookedUp.error ?? `no Massive front-month for ${code}` };
  const lookbackDays = query?.lookbackDays ?? 2;
  const sort = query?.sort ?? "asc";
  const cacheKey =
    lookbackDays === 2 && sort === "asc" ? front.ticker : `${front.ticker}|${lookbackDays}|${sort}`;
  const now = Date.now();
  const hit = futuresAggCache.get(cacheKey);
  if (hit && now - hit.at < MASSIVE_CACHE_MS) {
    return hit.value?.length
      ? { bars: hit.value, ticker: front.ticker }
      : { bars: [], ticker: front.ticker, error: "empty Massive futures aggs" };
  }
  const from = new Date(now - lookbackDays * 86_400_000);
  const url =
    `${MASSIVE_BASE}/futures/v1/aggs/${encodeURIComponent(front.ticker)}` +
    `?resolution=5min&limit=1000&sort=window_start.${sort}&window_start.gte=${ymdUtc(from)}`;
  const got = await massiveGetJson(url, key);
  if (!got.ok) {
    futuresAggCache.set(cacheKey, { at: now, value: null });
    return { bars: [], ticker: front.ticker, error: got.error };
  }
  const bars = parseMassiveFuturesAggs(got.body);
  futuresAggCache.set(cacheKey, { at: now, value: bars.length ? bars : null });
  if (!bars.length) return { bars: [], ticker: front.ticker, error: "empty Massive futures aggs" };
  return { bars, ticker: front.ticker };
}

function parseRight(raw: unknown): OptionRight | null {
  const s = str(raw)?.toLowerCase();
  if (s === "call" || s === "c") return "C";
  if (s === "put" || s === "p") return "P";
  return null;
}

export function parseMassiveOptionLeg(raw: unknown, fallbackUnderlying: string): OptionLeg | null {
  const o = asRecord(raw);
  if (!o) return null;
  const details = asRecord(o.details) ?? {};
  const strike = num(details.strike_price);
  if (strike === null) return null;
  const right = parseRight(details.contract_type);
  if (!right) return null;
  const expiry = str(details.expiration_date) ?? "";
  if (!expiry) return null;
  const osiKey = str(details.ticker) ?? "";
  const under =
    str(asRecord(o.underlying_asset)?.ticker) ??
    fallbackUnderlying;
  if (!under) return null;
  const q = asRecord(o.last_quote) ?? {};
  const t = asRecord(o.last_trade) ?? {};
  const g = asRecord(o.greeks) ?? {};
  return {
    underlying: under.toUpperCase(),
    osiKey,
    displaySymbol: osiKey || `${under.toUpperCase()} ${expiry} ${strike} ${right}`,
    right,
    strike,
    expiry,
    bid: num(q.bid),
    ask: num(q.ask),
    last: num(t.price),
    bidSize: num(q.bid_size),
    askSize: num(q.ask_size),
    openInterest: num(o.open_interest),
    delta: num(g.delta),
    gamma: num(g.gamma),
    theta: num(g.theta),
    vega: num(g.vega),
    iv: num(o.implied_volatility),
  };
}

export function parseMassiveOptionChain(
  bodies: unknown[],
  requested: string,
  expiry: string,
): OptionChainSnapshot {
  const legs: OptionLeg[] = [];
  let underlying = requested.toUpperCase();
  for (const body of bodies) {
    const root = asRecord(body);
    for (const row of asArray(root?.results)) {
      const leg = parseMassiveOptionLeg(row, requested);
      if (!leg) continue;
      if (expiry && leg.expiry !== expiry) continue;
      legs.push(leg);
      if (leg.underlying) underlying = leg.underlying;
    }
  }
  return {
    symbol: requested.toUpperCase(),
    underlying,
    expiry,
    delayed: true,
    source: "massive",
    chainType: "CALLPUT",
    legs,
  };
}

/** 3rd Friday (or legacy Saturday after) = MONTHLY; other Fridays = WEEKLY. */
export function inferExpiryType(expiry: string): string | null {
  const ymd = parseYmd(expiry);
  if (!ymd) return null;
  const dt = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  const dow = dt.getUTCDay();
  const first = new Date(Date.UTC(ymd.year, ymd.month - 1, 1));
  const firstDow = first.getUTCDay();
  const firstFriday = 1 + ((5 - firstDow + 7) % 7);
  const thirdFriday = firstFriday + 14;
  if (dow === 6 && ymd.day === thirdFriday + 1) return "MONTHLY";
  if (dow !== 5) return null;
  return ymd.day === thirdFriday ? "MONTHLY" : "WEEKLY";
}

export function parseMassiveExpiries(body: unknown, requested: string): OptionExpiriesResponse {
  const root = asRecord(body);
  const seen = new Set<string>();
  const expiries: OptionExpiry[] = [];
  for (const row of asArray(root?.results)) {
    const r = asRecord(row);
    if (!r) continue;
    const expiry = str(r.expiration_date);
    if (!expiry || seen.has(expiry)) continue;
    const ymd = parseYmd(expiry);
    if (!ymd) continue;
    seen.add(expiry);
    expiries.push({
      year: ymd.year,
      month: ymd.month,
      day: ymd.day,
      expiry,
      expiryType: inferExpiryType(expiry),
    });
  }
  expiries.sort((a, b) => a.expiry.localeCompare(b.expiry));
  return {
    symbol: requested.toUpperCase(),
    delayed: true,
    source: "massive",
    expiries,
  };
}

async function paginateResults(
  firstUrl: string,
  key: string,
): Promise<{ ok: true; bodies: unknown[] } | { ok: false; status: number; error: string }> {
  const bodies: unknown[] = [];
  let url: string | null = firstUrl;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const got = await massiveGetJson(url, key);
    if (!got.ok) return got;
    bodies.push(got.body);
    const next = str(asRecord(got.body)?.next_url);
    url = next ? stripApiKeyFromUrl(next) : null;
  }
  return { ok: true, bodies };
}

export async function fetchOptionExpiries(
  symbol: string,
): Promise<
  | { ok: true; data: OptionExpiriesResponse }
  | { ok: false; status: number; error: string }
> {
  const parsed = parseOptionsUnderlying(symbol);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  const key = massiveApiKey();
  if (!key) return { ok: false, status: 503, error: MASSIVE_KEY_MISSING };
  const now = Date.now();
  const hit = expiryCache.get(parsed.symbol);
  if (hit && now - hit.at < MASSIVE_CACHE_MS) return { ok: true, data: hit.value };
  const today = ymdUtc(new Date());
  const first =
    `${MASSIVE_BASE}/v3/reference/options/contracts?underlying_ticker=${encodeURIComponent(parsed.symbol)}` +
    `&expired=false&expiration_date.gte=${today}&limit=${MASSIVE_PAGE_LIMIT}&sort=expiration_date&order=asc`;
  const pages = await paginateResults(first, key);
  if (!pages.ok) return pages;
  const merged = { results: pages.bodies.flatMap((b) => asArray(asRecord(b)?.results)) };
  const data = parseMassiveExpiries(merged, parsed.symbol);
  expiryCache.set(parsed.symbol, { at: now, value: data });
  return { ok: true, data };
}

export async function fetchOptionChain(
  q: ChainQuery,
): Promise<
  | { ok: true; data: OptionChainSnapshot }
  | { ok: false; status: number; error: string }
> {
  const parsed = parseOptionsUnderlying(q.symbol);
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
  let year = q.expiryYear;
  let month = q.expiryMonth;
  let day = q.expiryDay;
  if (q.expiry) {
    const ymd = parseYmd(q.expiry);
    if (!ymd) return { ok: false, status: 400, error: "expiry must be YYYY-MM-DD" };
    year = ymd.year;
    month = ymd.month;
    day = ymd.day;
  }
  if (!year || !month || !day) {
    return { ok: false, status: 400, error: "expiryYear, expiryMonth, expiryDay (or expiry=YYYY-MM-DD) required" };
  }
  const expiry = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const key = massiveApiKey();
  if (!key) return { ok: false, status: 503, error: MASSIVE_KEY_MISSING };
  const cacheKey = `${parsed.symbol}:${expiry}`;
  const now = Date.now();
  const hit = chainCache.get(cacheKey);
  if (hit && now - hit.at < MASSIVE_CACHE_MS) return { ok: true, data: hit.value };

  const bodies: unknown[] = [];
  for (const contractType of ["call", "put"] as const) {
    const first =
      `${MASSIVE_BASE}/v3/snapshot/options/${encodeURIComponent(parsed.symbol)}` +
      `?expiration_date=${expiry}&contract_type=${contractType}&limit=${MASSIVE_PAGE_LIMIT}`;
    const pages = await paginateResults(first, key);
    if (!pages.ok) return pages;
    bodies.push(...pages.bodies);
  }
  const data = parseMassiveOptionChain(bodies, parsed.symbol, expiry);
  chainCache.set(cacheKey, { at: now, value: data });
  return { ok: true, data };
}

