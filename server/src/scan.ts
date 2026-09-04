import { REDIS_KEYS } from "../../shared/constants";
import type { ScanResponse, ScanRow, ScanSleeve } from "../../shared/types";
import {
  mapPool,
  QUOTE_FETCH_CONCURRENCY,
  YAHOO_UA,
} from "./quotes";
import { fetchMassiveDailyBars } from "./massive";
import type { RedisClient } from "./redis";
import { noteServiceDown, noteServiceUp } from "./eventGateAlerts";

export const SP500_CSV_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv";
export const UNIVERSE_TTL_MS = 24 * 60 * 60 * 1000;
export const FEATURES_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

const DOT_MAP: Record<string, string> = {
  "BRK.B": "BRK-B",
  "BF.B": "BF-B",
};

/** Yahoo equity ticker. Maps BRK.B/BF.B; skips other dotted symbols Yahoo hates. */
export function yahooEquityTicker(symbol: string): string | null {
  const t = symbol.trim().toUpperCase();
  if (!t) return null;
  if (DOT_MAP[t]) return DOT_MAP[t];
  if (t.includes(".")) return null;
  return t;
}

export interface UniverseName {
  symbol: string;
  yahoo: string;
  name: string;
  sector: string;
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ",") {
      row.push(cur);
      cur = "";
    } else if (ch === "\n") {
      row.push(cur);
      if (row.some((c) => c.length)) rows.push(row);
      row = [];
      cur = "";
    } else if (ch !== "\r") {
      cur += ch;
    }
  }
  if (cur.length || row.length) {
    row.push(cur);
    if (row.some((c) => c.length)) rows.push(row);
  }
  return rows;
}

export function parseConstituentsCsv(csv: string): UniverseName[] {
  const rows = parseCsvRows(csv);
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const iSym = header.indexOf("symbol");
  const iName = header.indexOf("security");
  const iSec = header.indexOf("gics sector");
  if (iSym < 0 || iName < 0 || iSec < 0) return [];
  const out: UniverseName[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(1)) {
    const raw = (row[iSym] ?? "").trim();
    const yahoo = yahooEquityTicker(raw);
    if (!yahoo || seen.has(yahoo)) continue;
    const name = (row[iName] ?? "").trim();
    const sector = (row[iSec] ?? "").trim();
    if (!sector) continue;
    seen.add(yahoo);
    out.push({ symbol: raw.toUpperCase(), yahoo, name, sector });
  }
  return out;
}

export interface DailyBar {
  close: number;
  volume: number;
}

export interface ScanFeatures {
  last: number;
  sma20: number;
  sma200: number;
  high52: number;
  pctFrom52: number;
  dist20: number;
  above200: boolean;
  ret63: number | null;
  ret126: number | null;
  ret252: number | null;
  has252: boolean;
  volx: number;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  let s = 0;
  for (const x of xs) {
    if (!Number.isFinite(x)) return null;
    s += x;
  }
  return s / xs.length;
}

function lookbackRet(
  closes: number[],
  period: number,
): { value: number | null; exact: boolean } {
  const n = closes.length;
  const last = closes[n - 1];
  if (!(last > 0) || n < 2) return { value: null, exact: false };
  if (n > period) {
    const base = closes[n - 1 - period];
    if (!(base > 0)) return { value: null, exact: false };
    return { value: last / base - 1, exact: true };
  }
  const base = closes[0];
  if (!(base > 0)) return { value: null, exact: false };
  return { value: last / base - 1, exact: false };
}

/** Pure. Returns null if <200 finite closes — never fabricates last/SMA. */
export function featuresFromBars(bars: DailyBar[]): ScanFeatures | null {
  const closes: number[] = [];
  const volumes: number[] = [];
  for (const b of bars) {
    if (typeof b.close === "number" && Number.isFinite(b.close)) {
      closes.push(b.close);
      volumes.push(
        typeof b.volume === "number" && Number.isFinite(b.volume) ? b.volume : 0,
      );
    }
  }
  if (closes.length < 200) return null;
  const last = closes[closes.length - 1];
  if (!(last > 0)) return null;
  const sma20 = mean(closes.slice(-20));
  const sma200 = mean(closes.slice(-200));
  if (sma20 === null || sma200 === null || !(sma20 > 0) || !(sma200 > 0)) return null;
  let high52 = -Infinity;
  for (const c of closes) {
    if (c > high52) high52 = c;
  }
  if (!(high52 > 0)) return null;
  const avgVol20 = mean(volumes.slice(-20));
  if (avgVol20 === null || !(avgVol20 > 0)) return null;
  const lastVol = volumes[volumes.length - 1];
  const r63 = lookbackRet(closes, 63);
  const r126 = lookbackRet(closes, 126);
  const r252 = lookbackRet(closes, 252);
  return {
    last,
    sma20,
    sma200,
    high52,
    pctFrom52: last / high52 - 1,
    dist20: last / sma20 - 1,
    above200: last > sma200,
    ret63: r63.value,
    ret126: r126.value,
    ret252: r252.value,
    has252: r252.exact,
    volx: lastVol / avgVol20,
  };
}

export function parseYahooDailyBars(body: unknown): DailyBar[] | null {
  const chart = (
    body as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              close?: Array<number | null>;
              volume?: Array<number | null>;
            }>;
          };
        }>;
        error?: unknown;
      };
    }
  ).chart;
  if (!chart) return null;
  const result = chart.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close;
  const vols = result?.indicators?.quote?.[0]?.volume;
  if (!Array.isArray(closes)) return null;
  const bars: DailyBar[] = [];
  for (let i = 0; i < closes.length; i++) {
    const c = closes[i];
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    const v = vols?.[i];
    bars.push({
      close: c,
      volume: typeof v === "number" && Number.isFinite(v) ? v : 0,
    });
  }
  return bars.length ? bars : null;
}

/** Pullback-after-strength: above 200dma, near 52w high, last close to 20dma. */
export function passesMomentumFilter(f: {
  above200: boolean;
  pctFrom52: number;
  dist20: number;
}): boolean {
  return (
    f.above200 &&
    f.pctFrom52 >= -0.1 &&
    f.dist20 >= -0.04 &&
    f.dist20 <= 0.03
  );
}

export function passesOwnershipFilter(f: ScanFeatures): boolean {
  if (!f.above200) return false;
  const p3 = f.ret63 !== null && f.ret63 > 0;
  const p6 = f.ret126 !== null && f.ret126 > 0;
  const p12 = f.ret252 !== null && f.ret252 > 0;
  if (!f.has252) return [p3, p6, p12].filter(Boolean).length >= 2;
  return p3 && p6 && p12;
}

/** rs3m + 0.25 * rs12m-ish + small volx bonus. Pure — no fetch, no invented prices. */
export function momentumScore(f: ScanFeatures, spyRet63: number, spyRet252: number): number {
  const rs3m = (f.ret63 ?? 0) - spyRet63;
  const rs12m = (f.ret252 ?? 0) - spyRet252;
  const volxBonus = 0.01 * Math.max(0, Math.min(f.volx, 2) - 1);
  return rs3m + 0.25 * rs12m + volxBonus;
}

export interface FeatureRow {
  symbol: string;
  name: string;
  sector: string;
  features: ScanFeatures;
}

function pctLabel(n: number | null, digits = 1): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const sign = n > 0 ? "+" : "";
  return `${sign}${(n * 100).toFixed(digits)}%`;
}

function toRow(
  row: FeatureRow,
  score: number,
  rs3m: number | null,
  why: string,
): ScanRow {
  const f = row.features;
  return {
    symbol: row.symbol,
    name: row.name,
    sector: row.sector,
    last: f.last,
    pctFrom52: f.pctFrom52,
    dist20: f.dist20,
    above200: f.above200,
    ret3m: f.ret63,
    ret6m: f.ret126,
    ret12m: f.ret252,
    rs3m,
    volx: f.volx,
    score,
    why,
  };
}

export function rankMomentum(
  rows: FeatureRow[],
  spyRet63: number,
  spyRet252: number,
  limit = 15,
): ScanRow[] {
  const scored: ScanRow[] = [];
  for (const row of rows) {
    const f = row.features;
    if (!passesMomentumFilter(f) || f.ret63 === null) continue;
    const rs3m = f.ret63 - spyRet63;
    const score = momentumScore(f, spyRet63, spyRet252);
    scored.push(
      toRow(row, score, rs3m, `above 200 · pullback 20dma · RS3m ${pctLabel(rs3m)}`),
    );
  }
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const out: ScanRow[] = [];
  for (const r of scored) {
    if (seen.has(r.sector)) continue;
    seen.add(r.sector);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export function rankOwnership(
  rows: FeatureRow[],
  spyRet63: number,
  limit = 20,
): ScanRow[] {
  const scored: ScanRow[] = [];
  for (const row of rows) {
    const f = row.features;
    if (!passesOwnershipFilter(f)) continue;
    const score = f.ret252 ?? f.ret126 ?? f.ret63 ?? 0;
    const rs3m = f.ret63 !== null ? f.ret63 - spyRet63 : null;
    const legs = [
      f.ret63 !== null && f.ret63 > 0 ? "3m" : null,
      f.ret126 !== null && f.ret126 > 0 ? "6m" : null,
      f.ret252 !== null && f.ret252 > 0 ? "12m" : null,
    ]
      .filter((x): x is string => x !== null)
      .join("/");
    scored.push(toRow(row, score, rs3m, `uptrend ${legs} · 12m ${pctLabel(f.ret252)}`));
  }
  scored.sort((a, b) => b.score - a.score);
  const counts = new Map<string, number>();
  const out: ScanRow[] = [];
  for (const r of scored) {
    const n = counts.get(r.sector) ?? 0;
    if (n >= 2) continue;
    counts.set(r.sector, n + 1);
    out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

export interface FeaturesCache {
  at: number;
  asOf: string;
  spyRet63: number;
  spyRet252: number;
  rows: FeatureRow[];
}

let redis: RedisClient | null = null;
let universeMem: { at: number; names: UniverseName[] } | null = null;
let featuresMem: FeaturesCache | null = null;
let inflight: Promise<void> | null = null;

export function resetScanCache(): void {
  universeMem = null;
  featuresMem = null;
  inflight = null;
}

export function attachScanRedis(client: RedisClient | null): void {
  redis = client;
}

let scanReadyHook: (() => void) | null = null;

/** Fired after a scan publishes the feature cache. Must not await inside runScan. */
export function attachScanReady(cb: (() => void) | null): void {
  scanReadyHook = cb;
}

export function getScanFeaturesCache(): FeaturesCache | null {
  return featuresMem;
}

async function hydrateFromRedis(): Promise<void> {
  if (!redis) return;
  try {
    if (!universeMem) {
      const raw = await redis.get(REDIS_KEYS.scanUniverse);
      if (raw) {
        const parsed = JSON.parse(raw) as { at?: number; names?: UniverseName[] };
        if (Array.isArray(parsed.names) && typeof parsed.at === "number") {
          universeMem = { at: parsed.at, names: parsed.names };
        }
      }
    }
    if (!featuresMem) {
      const raw = await redis.get(REDIS_KEYS.scanFeatures);
      if (raw) {
        const parsed = JSON.parse(raw) as FeaturesCache;
        if (
          parsed &&
          typeof parsed.at === "number" &&
          typeof parsed.asOf === "string" &&
          typeof parsed.spyRet63 === "number" &&
          typeof parsed.spyRet252 === "number" &&
          Array.isArray(parsed.rows)
        ) {
          featuresMem = parsed;
        }
      }
    }
  } catch {
    /* keep memory */
  }
}

async function persistUniverse(names: UniverseName[], at: number): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(REDIS_KEYS.scanUniverse, JSON.stringify({ at, names }), {
      PX: UNIVERSE_TTL_MS,
    });
  } catch {
    /* ignore */
  }
}

async function persistFeatures(cache: FeaturesCache): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(REDIS_KEYS.scanFeatures, JSON.stringify(cache), {
      PX: FEATURES_TTL_MS * 8,
    });
  } catch {
    /* ignore */
  }
}

async function fetchText(url: string): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": YAHOO_UA },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": YAHOO_UA },
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadUniverse(now: number): Promise<UniverseName[]> {
  if (universeMem && now - universeMem.at < UNIVERSE_TTL_MS) return universeMem.names;
  try {
    const csv = await fetchText(SP500_CSV_URL);
    const names = parseConstituentsCsv(csv);
    if (names.length) {
      universeMem = { at: now, names };
      await persistUniverse(names, now);
      return names;
    }
  } catch (err) {
    console.warn(
      "[EventGate] S&P 500 CSV fetch failed",
      err instanceof Error ? err.message : err,
    );
  }
  if (universeMem) return universeMem.names;
  return [];
}

async function fetchDailyBars(ticker: string): Promise<DailyBar[] | null> {
  const bars = await fetchMassiveDailyBars(ticker);
  return bars;
}

async function runScan(): Promise<void> {
  const started = Date.now();
  const names = await loadUniverse(started);
  if (!names.length) {
    console.warn("[EventGate] scan aborted — empty universe");
    return;
  }
  const spyBars = await fetchDailyBars("SPY");
  const spyFeat = spyBars ? featuresFromBars(spyBars) : null;
  if (!spyFeat || spyFeat.ret63 === null || spyFeat.ret252 === null) {
    console.warn("[EventGate] scan aborted — SPY benchmark missing (no fake RS)");
    return;
  }
  let ok = 0;
  let skip = 0;
  const rows: FeatureRow[] = [];
  await mapPool(names, QUOTE_FETCH_CONCURRENCY, async (n) => {
    const bars = await fetchDailyBars(n.symbol);
    const feat = bars ? featuresFromBars(bars) : null;
    if (!feat) {
      skip++;
      return;
    }
    ok++;
    rows.push({ symbol: n.symbol, name: n.name, sector: n.sector, features: feat });
  });
  const cache: FeaturesCache = {
    at: Date.now(),
    asOf: new Date().toISOString(),
    spyRet63: spyFeat.ret63,
    spyRet252: spyFeat.ret252,
    rows,
  };
  featuresMem = cache;
  await persistFeatures(cache);
  const sec = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `[EventGate] scan done universe=${names.length} features=${ok} skip=${skip} ${sec}s`,
  );
  noteServiceUp("quotes");
  // Publish first, then notify. Do not await autopilot — would deadlock while inflight.
  if (scanReadyHook) {
    try {
      scanReadyHook();
    } catch (err) {
      console.error(
        "[EventGate] scan ready hook failed",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export function kickScan(): void {
  if (inflight) return;
  inflight = runScan()
    .catch((err) => {
      console.error("[EventGate] scan failed", err instanceof Error ? err.message : err);
      void noteServiceDown("quotes");
    })
    .finally(() => {
      inflight = null;
    });
}

function scanningBody(sleeve: ScanSleeve): ScanResponse {
  return {
    sleeve,
    asOf: null,
    universe: "sp500",
    delayed: true,
    source: "massive",
    status: "scanning",
    rows: [],
  };
}

export async function getScan(sleeve: ScanSleeve): Promise<ScanResponse> {
  await hydrateFromRedis();
  const now = Date.now();
  if (!featuresMem) {
    kickScan();
    return scanningBody(sleeve);
  }
  if (now - featuresMem.at >= FEATURES_TTL_MS) kickScan();
  const rows =
    sleeve === "momentum"
      ? rankMomentum(featuresMem.rows, featuresMem.spyRet63, featuresMem.spyRet252)
      : rankOwnership(featuresMem.rows, featuresMem.spyRet63);
  return {
    sleeve,
    asOf: featuresMem.asOf,
    universe: "sp500",
    delayed: true,
    source: "massive",
    status: "ok",
    rows,
  };
}
