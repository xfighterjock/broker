import type { DelayedQuote, SleeveCard, SleeveId } from "../../shared/types";
import { fetchMassiveQuote } from "./massive";

export const DEFAULT_SYMBOLS: Record<SleeveId, string[]> = {
  day: ["MES=F", "ZN=F", "M6E=F", "SR3=F"],
  momentum: ["MES=F", "ES=F", "SPY", "QQQ", "TLT"],
  options: ["SPY", "QQQ", "IWM"],
  ownership: ["SPY", "QQQ", "TLT", "IWM"],
};

/** Exact root → Yahoo futures ticker. Longer keys are not prefixes of shorter ones here. */
export const ROOT_TO_YAHOO: Record<string, string> = {
  MES: "MES=F",
  ZN: "ZN=F",
  M6E: "M6E=F",
  "6E": "6E=F",
  SR3: "SR3=F",
  ES: "ES=F",
  NQ: "NQ=F",
  MNQ: "MNQ=F",
};

export const YAHOO_CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart/";
export const YAHOO_UA = "Mozilla/5.0 EventGate/1.0";
export const QUOTE_CACHE_MS = 45_000;
export const QUOTE_FETCH_CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 8_000;

type CacheEntry = { quote: DelayedQuote; at: number };
const cache = new Map<string, CacheEntry>();

export function resetQuoteCache(): void {
  cache.clear();
}

export function mapTicker(raw: string): string | null {
  const t = raw.trim().toUpperCase();
  if (!t) return null;
  if (t.includes("=")) return t;
  return ROOT_TO_YAHOO[t] ?? t;
}

export function parseInstrumentTickers(instruments: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of instruments.split(/[,/\s]+/)) {
    const mapped = mapTicker(part);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    out.push(mapped);
  }
  return out;
}

export function symbolsForSleeve(sleeve: SleeveCard | undefined, id: SleeveId): string[] {
  const instruments = sleeve?.instruments?.trim() ?? "";
  if (instruments) {
    const parsed = parseInstrumentTickers(instruments);
    if (parsed.length) return parsed;
  }
  return [...DEFAULT_SYMBOLS[id]];
}

function errorQuote(
  symbol: string,
  error: string,
  source: DelayedQuote["source"] = "yahoo",
): DelayedQuote {
  return {
    symbol,
    last: null,
    prevClose: null,
    change: null,
    changePct: null,
    asOf: null,
    exchange: null,
    delayed: true,
    source,
    error,
  };
}

/** Yahoo only for futures =F / MES,ZN,6E,M6E,SR3,ES,NQ,MNQ. Equities go to Massive. */
export function isYahooFuturesSymbol(symbol: string): boolean {
  const t = symbol.trim().toUpperCase();
  if (!t) return false;
  if (t.includes("=")) return true;
  return t in ROOT_TO_YAHOO;
}


export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }
  const n = Math.max(1, Math.min(limit, items.length));
  if (items.length === 0) return results;
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

interface YahooChartMeta {
  symbol?: string;
  regularMarketPrice?: number;
  previousClose?: number;
  chartPreviousClose?: number;
  regularMarketTime?: number;
  exchangeName?: string;
  instrumentType?: string;
}

function parseYahooChart(symbol: string, body: unknown): DelayedQuote {
  const chart = (
    body as {
      chart?: {
        result?: Array<{ meta?: YahooChartMeta }>;
        error?: { description?: string } | string | null;
      };
    }
  ).chart;
  if (!chart) return errorQuote(symbol, "no chart");
  if (typeof chart.error === "string" && chart.error) return errorQuote(symbol, chart.error);
  if (chart.error && typeof chart.error === "object" && chart.error.description) {
    return errorQuote(symbol, chart.error.description);
  }
  const meta = chart.result?.[0]?.meta;
  if (!meta) return errorQuote(symbol, "no chart result");
  const last =
    typeof meta.regularMarketPrice === "number" && Number.isFinite(meta.regularMarketPrice)
      ? meta.regularMarketPrice
      : null;
  if (last === null) return errorQuote(symbol, "no regularMarketPrice");
  const prevRaw = meta.previousClose ?? meta.chartPreviousClose;
  const prevClose = typeof prevRaw === "number" && Number.isFinite(prevRaw) ? prevRaw : null;
  const change = prevClose !== null ? last - prevClose : null;
  const changePct =
    change !== null && prevClose !== null && prevClose !== 0 ? (change / prevClose) * 100 : null;
  const ts = meta.regularMarketTime;
  const asOf =
    typeof ts === "number" && Number.isFinite(ts) && ts > 0
      ? new Date(ts * 1000).toISOString()
      : null;
  return {
    symbol: typeof meta.symbol === "string" && meta.symbol ? meta.symbol : symbol,
    last,
    prevClose,
    change,
    changePct,
    asOf,
    exchange: typeof meta.exchangeName === "string" ? meta.exchangeName : null,
    delayed: true,
    source: "yahoo",
  };
}

async function fetchYahooOne(symbol: string, now: number): Promise<DelayedQuote> {
  const url = `${YAHOO_CHART_BASE}${encodeURIComponent(symbol)}?interval=5m&range=1d`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": YAHOO_UA },
      signal: ac.signal,
    });
    if (!res.ok) {
      return errorQuote(symbol, `http ${res.status}`, "yahoo");
    }
    const body: unknown = await res.json();
    return parseYahooChart(symbol, body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorQuote(symbol, msg, "yahoo");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOne(symbol: string, now: number): Promise<DelayedQuote> {
  const hit = cache.get(symbol);
  if (hit && now - hit.at < QUOTE_CACHE_MS) return hit.quote;

  let q: DelayedQuote;
  if (isYahooFuturesSymbol(symbol)) {
    q = await fetchYahooOne(symbol, now);
  } else {
    q = await fetchMassiveQuote(symbol);
  }
  cache.set(symbol, { quote: q, at: now });
  return q;
}

export async function fetchDelayedQuotes(symbols: string[]): Promise<DelayedQuote[]> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const s of symbols) {
    const mapped = mapTicker(s);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    unique.push(mapped);
  }
  const now = Date.now();
  return mapPool(unique, QUOTE_FETCH_CONCURRENCY, (sym) => fetchOne(sym, now));
}
