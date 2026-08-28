import path from "node:path";
import type {
  DelayedQuote,
  OptionChainSnapshot,
  OptionExpiry,
  OptionExpiriesResponse,
  OptionLeg,
  OptionRight,
} from "../../shared/types";
import { loadEnvFile, parseYmd, type ChainQuery } from "./etrade";

export const MASSIVE_BASE = "https://api.massive.com";
export const MASSIVE_UA = "EventGate/1.0";
export const MASSIVE_CACHE_MS = 45_000;
export const MASSIVE_FETCH_TIMEOUT_MS = 12_000;
export const MASSIVE_PAGE_LIMIT = 250;
const MAX_PAGES = 20;
const AGG_LOOKBACK_DAYS = 420;

export type DailyBar = { close: number; volume: number };

type CacheEntry<T> = { at: number; value: T };
const expiryCache = new Map<string, CacheEntry<OptionExpiriesResponse>>();
const chainCache = new Map<string, CacheEntry<OptionChainSnapshot>>();
const aggCache = new Map<string, CacheEntry<DailyBar[] | null>>();

export function resetMassiveCache(): void {
  expiryCache.clear();
  chainCache.clear();
  aggCache.clear();
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
  "MASSIVE_API_KEY missing. Equities/options need Massive Starter (15-min delayed). Futures still use Yahoo.";

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
  const got = await massiveGetJson(url, key);
  if (!got.ok) {
    aggCache.set(ticker, { at: now, value: null });
    return null;
  }
  const bars = parseMassiveDailyBars(got.body);
  aggCache.set(ticker, { at: now, value: bars });
  return bars;
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

