import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { etParts } from "../../shared/clock";
import {
  ETRADE_PROD_BASE,
  ETRADE_SANDBOX_BASE,
  OPTIONS_V1_SYMBOLS,
} from "../../shared/constants";
import type {
  OptionChainSnapshot,
  OptionExpiry,
  OptionExpiriesResponse,
  OptionLeg,
  OptionRight,
} from "../../shared/types";
import sandboxOptionChainJson from "./sandbox-optionchain.json" with { type: "json" };

export const ETRADE_FETCH_TIMEOUT_MS = 12_000;
export const ETRADE_CACHE_MS = 45_000;
/** Idle access tokens drop after ~2h. Renew this often during the cash session. */
export const ETRADE_ACCESS_TOKEN_RENEW_MS = 30 * 60 * 1000;
/** First keep-alive tick after listen — not a long wait. */
export const ETRADE_ACCESS_TOKEN_RENEW_FIRST_DELAY_MS = 0;
/** Mon–Fri cash session start in America/New_York minutes from midnight (09:30). */
export const ETRADE_CASH_SESSION_START_MINUTES = 9 * 60 + 30;
/** Inclusive cash session end in America/New_York minutes from midnight (16:00). */
export const ETRADE_CASH_SESSION_END_MINUTES = 16 * 60;

const ET_WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri"]);

export type EtradeEnvName = "sandbox" | "production";

export type EtradeCreds = {
  env: EtradeEnvName;
  baseUrl: string;
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessSecret: string;
};

export type EtradeCredsErr = { error: string; status: number };

type CacheEntry<T> = { at: number; value: T };
const expiryCache = new Map<string, CacheEntry<OptionExpiriesResponse>>();
const chainCache = new Map<string, CacheEntry<OptionChainSnapshot>>();

export function resetEtradeCache(): void {
  expiryCache.clear();
  chainCache.clear();
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

function percentEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Fill unset process.env keys from a KEY=VALUE file. Never logs values. */
export function loadEnvFile(filePath: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(filePath)) return;
  let raw = "";
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key || env[key] !== undefined) continue;
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
}

export function etradeEnvFileCandidates(cwd = process.cwd()): string[] {
  return [path.resolve(cwd, ".env.etrade"), path.resolve(cwd, "..", ".env.etrade")];
}

export function findEtradeEnvFile(cwd = process.cwd()): string | null {
  for (const f of etradeEnvFileCandidates(cwd)) {
    if (existsSync(f)) return f;
  }
  return null;
}

export function maybeLoadEtradeDotenv(env: NodeJS.ProcessEnv = process.env): void {
  if ((env.NODE_ENV || "").toLowerCase() === "test") return;
  const f = findEtradeEnvFile();
  if (f) loadEnvFile(f, env);
}

/** Upsert KEY=VALUE lines. chmod 600. Never logs values. */
export function upsertEnvFile(filePath: string, updates: Record<string, string>): void {
  const orig = existsSync(filePath) ? readFileSync(filePath, "utf8") : "";
  const seen = new Set<string>();
  const lines = orig.split("\n");
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) return line;
    const k = t.slice(0, t.indexOf("="));
    if (k in updates) {
      seen.add(k);
      return `${k}=${updates[k]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }
  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  writeFileSync(filePath, text, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

export function etradeAccessEnvKeys(name: EtradeEnvName): { token: string; secret: string } {
  return name === "sandbox"
    ? { token: "ETRADE_SANDBOX_ACCESS_TOKEN", secret: "ETRADE_SANDBOX_ACCESS_SECRET" }
    : { token: "ETRADE_PROD_ACCESS_TOKEN", secret: "ETRADE_PROD_ACCESS_SECRET" };
}

export function etradeEnvName(env: NodeJS.ProcessEnv = process.env): EtradeEnvName {
  const raw = (env.ETRADE_ENV || "sandbox").toLowerCase();
  if (raw === "production" || raw === "prod" || raw === "live") return "production";
  return "sandbox";
}

export function etradeBaseUrl(name: EtradeEnvName = etradeEnvName()): string {
  return name === "production" ? ETRADE_PROD_BASE : ETRADE_SANDBOX_BASE;
}

export function loadEtradeCreds(env: NodeJS.ProcessEnv = process.env): EtradeCreds | EtradeCredsErr {
  maybeLoadEtradeDotenv(env);
  const name = etradeEnvName(env);
  const sandbox = name === "sandbox";
  const consumerKey = sandbox
    ? env.ETRADE_SANDBOX_KEY
    : env.ETRADE_PROD_KEY || env.ETRADE_KEY;
  const consumerSecret = sandbox
    ? env.ETRADE_SANDBOX_SECRET
    : env.ETRADE_PROD_SECRET || env.ETRADE_SECRET;
  const accessToken = sandbox
    ? env.ETRADE_SANDBOX_ACCESS_TOKEN
    : env.ETRADE_PROD_ACCESS_TOKEN || env.ETRADE_ACCESS_TOKEN;
  const accessSecret = sandbox
    ? env.ETRADE_SANDBOX_ACCESS_SECRET
    : env.ETRADE_PROD_ACCESS_SECRET || env.ETRADE_ACCESS_SECRET;
  if (!consumerKey || !consumerSecret) {
    return {
      status: 503,
      error:
        "E*TRADE Market API credentials missing. Chain-only; PIN handshake is not implemented. Set sandbox key/secret.",
    };
  }
  if (!accessToken || !accessSecret) {
    return {
      status: 503,
      error:
        "E*TRADE access tokens missing. PIN handshake is not implemented. Market chain endpoints unavailable.",
    };
  }
  return {
    env: name,
    baseUrl: etradeBaseUrl(name),
    consumerKey,
    consumerSecret,
    accessToken,
    accessSecret,
  };
}

export type EtradeRenewOk = { ok: true; rotated: boolean };
export type EtradeRenewErr = {
  ok: false;
  error: string;
  status: number;
  /** Missing creds: timer should stay quiet. */
  silent?: boolean;
};
export type EtradeRenewResult = EtradeRenewOk | EtradeRenewErr;

export type EtradeFetchFn = (
  input: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export type RenewAccessTokenOpts = {
  env?: NodeJS.ProcessEnv;
  envFile?: string;
  fetch?: EtradeFetchFn;
  log?: (msg: string) => void;
};

function parseOAuthQs(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(body).trim().split("&")) {
    if (!part.includes("=")) continue;
    const i = part.indexOf("=");
    try {
      out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
    } catch {
      /* skip malformed pair */
    }
  }
  return out;
}

function credsMissingKind(err: string): "missing credentials" | "missing access token" | null {
  if (/access tokens missing/i.test(err)) return "missing access token";
  if (/credentials missing/i.test(err)) return "missing credentials";
  return null;
}

function applyAccessTokensToEnv(
  env: NodeJS.ProcessEnv,
  name: EtradeEnvName,
  token: string,
  secret: string,
): Record<string, string> {
  const keys = etradeAccessEnvKeys(name);
  const updates: Record<string, string> = {
    [keys.token]: token,
    [keys.secret]: secret,
  };
  env[keys.token] = token;
  env[keys.secret] = secret;
  if (name === "production") {
    if (env.ETRADE_ACCESS_TOKEN !== undefined) env.ETRADE_ACCESS_TOKEN = token;
    if (env.ETRADE_ACCESS_SECRET !== undefined) env.ETRADE_ACCESS_SECRET = secret;
  }
  return updates;
}

/**
 * GET {base}/oauth/renew_access_token signed OAuth 1.0a with the current access token.
 * Quotes/chains keep-alive only. Midnight ET still needs a human PIN (CLI request + access);
 * this only resets idle expiry.
 */
export async function renewAccessToken(
  opts: RenewAccessTokenOpts = {},
): Promise<EtradeRenewResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);

  try {
    const creds = loadEtradeCreds(env);
    if ("error" in creds) {
      const kind = credsMissingKind(creds.error);
      return {
        ok: false,
        error: kind ?? "missing credentials",
        status: creds.status,
        silent: true,
      };
    }

    const url = `${creds.baseUrl}/oauth/renew_access_token`;
    const signed = signEtradeGet(url, {}, creds);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), ETRADE_FETCH_TIMEOUT_MS);
    let status = 0;
    let text = "";
    try {
      const res = await fetchFn(signed.href, {
        method: "GET",
        headers: { Authorization: signed.authorization },
        signal: ac.signal,
      });
      status = res.status;
      text = await res.text();
      if (!res.ok) {
        const error = `HTTP ${status}`;
        log(`[EventGate] etrade renew failed: ${error}`);
        return { ok: false, error, status };
      }
    } catch {
      log("[EventGate] etrade renew failed: unreachable");
      return { ok: false, error: "unreachable", status: 502 };
    } finally {
      clearTimeout(timer);
    }

    const parsed = parseOAuthQs(text);
    const newToken = parsed.oauth_token?.trim() ?? "";
    const newSecret = parsed.oauth_token_secret?.trim() ?? "";
    if (newToken && newSecret) {
      const updates = applyAccessTokensToEnv(env, creds.env, newToken, newSecret);
      const envFile = opts.envFile ?? findEtradeEnvFile();
      if (envFile) {
        try {
          upsertEnvFile(envFile, updates);
        } catch {
          log("[EventGate] etrade renew failed: could not write env file");
        }
      }
    }

    log("[EventGate] etrade access token renewed");
    return { ok: true, rotated: Boolean(newToken && newSecret) };
  } catch {
    log("[EventGate] etrade renew failed");
    return { ok: false, error: "etrade renew failed", status: 502 };
  }
}

export function etradeKeepAliveEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.NODE_ENV || "").toLowerCase() !== "test";
}

/** Weekdays during the cash session in America/New_York. Nights and weekends skip. */
export function isEtradeCashSession(now: Date = new Date()): boolean {
  const p = etParts(now);
  if (!ET_WEEKDAYS.has(p.weekday)) return false;
  const minutes = p.hour * 60 + p.minute;
  return (
    minutes >= ETRADE_CASH_SESSION_START_MINUTES && minutes <= ETRADE_CASH_SESSION_END_MINUTES
  );
}

export type EtradeKeepAliveOpts = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  renew?: (opts?: RenewAccessTokenOpts) => Promise<EtradeRenewResult>;
  log?: (msg: string) => void;
};

let keepAliveInterval: ReturnType<typeof setInterval> | null = null;
let keepAliveFirst: ReturnType<typeof setTimeout> | null = null;

export function stopEtradeAccessTokenKeepAlive(): void {
  if (keepAliveFirst) {
    clearTimeout(keepAliveFirst);
    keepAliveFirst = null;
  }
  if (keepAliveInterval) {
    clearInterval(keepAliveInterval);
    keepAliveInterval = null;
  }
}

/**
 * In-process access-token keep-alive. Starts from the listen callback.
 * Skips NODE_ENV=test, nights, and weekends. Midnight ET still needs a PIN.
 */
export function startEtradeAccessTokenKeepAlive(opts: EtradeKeepAliveOpts = {}): () => void {
  stopEtradeAccessTokenKeepAlive();
  const env = opts.env ?? process.env;
  if (!etradeKeepAliveEnabled(env)) return stopEtradeAccessTokenKeepAlive;

  const log = opts.log ?? ((msg: string) => console.log(msg));
  const nowFn = opts.now ?? (() => new Date());
  const renew = opts.renew ?? renewAccessToken;

  const tick = (): void => {
    if (!isEtradeCashSession(nowFn())) return;
    void renew({ env, log })
      .then((got) => {
        if (!got.ok && got.silent) return;
      })
      .catch(() => {
        /* never crash the process */
      });
  };

  keepAliveFirst = setTimeout(tick, ETRADE_ACCESS_TOKEN_RENEW_FIRST_DELAY_MS);
  keepAliveInterval = setInterval(tick, ETRADE_ACCESS_TOKEN_RENEW_MS);
  return stopEtradeAccessTokenKeepAlive;
}

export function isOptionsV1Symbol(raw: string): boolean {
  return (OPTIONS_V1_SYMBOLS as readonly string[]).includes(raw.trim().toUpperCase());
}

/** Any ordinary US option root. Live E*TRADE is not limited to SPY/QQQ/IWM. */
export function isOptionUnderlying(raw: string): boolean {
  return /^[A-Z][A-Z0-9.]{0,9}$/.test(raw.trim().toUpperCase());
}

export function parseExpiryYmd(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function parseExpiryFromOsi(osiKey: string): string | null {
  const m = osiKey.toUpperCase().match(/(\d{6})([CP])/);
  if (!m) return null;
  const ymd = m[1];
  const yy = Number(ymd.slice(0, 2));
  const mm = Number(ymd.slice(2, 4));
  const dd = Number(ymd.slice(4, 6));
  const year = yy >= 70 ? 1900 + yy : 2000 + yy;
  return parseExpiryYmd(year, mm, dd);
}

function oauthHeader(
  method: string,
  url: string,
  query: Record<string, string>,
  creds: EtradeCreds,
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: creds.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: creds.accessToken,
    oauth_version: "1.0",
  };
  const params: Record<string, string> = { ...query, ...oauth };
  const encoded = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const base = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(encoded)}`;
  const key = `${percentEncode(creds.consumerSecret)}&${percentEncode(creds.accessSecret)}`;
  const signature = createHmac("sha1", key).update(base).digest("base64");
  oauth.oauth_signature = signature;
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
      .join(", ")
  );
}

export function signEtradeGet(
  url: string,
  query: Record<string, string>,
  creds: EtradeCreds,
): { authorization: string; href: string } {
  const authorization = oauthHeader("GET", url, query, creds);
  const q = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");
  return { authorization, href: q ? `${url}?${q}` : url };
}

async function etradeGetJson(
  relPath: string,
  query: Record<string, string>,
  creds: EtradeCreds,
): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  const url = `${creds.baseUrl}${relPath}`;
  const signed = signEtradeGet(url, query, creds);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ETRADE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(signed.href, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: signed.authorization,
      },
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status === 401 || res.status === 403 ? 503 : 502,
        error: `E*TRADE Market API ${res.status} on ${relPath}`,
      };
    }
    try {
      return { ok: true, body: JSON.parse(text) as unknown };
    } catch {
      return { ok: false, status: 502, error: "E*TRADE Market API returned non-JSON" };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: 502, error: `E*TRADE Market API unreachable (${msg})` };
  } finally {
    clearTimeout(timer);
  }
}

function parseGreeks(raw: unknown): Pick<OptionLeg, "delta" | "gamma" | "theta" | "vega" | "iv"> {
  const g = asRecord(raw) ?? {};
  return {
    delta: num(g.delta),
    gamma: num(g.gamma),
    theta: num(g.theta),
    vega: num(g.vega),
    iv: num(g.iv),
  };
}

function parseRight(raw: unknown, fallback: OptionRight): OptionRight {
  const s = str(raw)?.toUpperCase();
  if (s === "C" || s === "CALL") return "C";
  if (s === "P" || s === "PUT") return "P";
  return fallback;
}

export function parseOptionLeg(
  raw: unknown,
  fallbackRight: OptionRight,
  fallbackExpiry: string | null,
): OptionLeg | null {
  const o = asRecord(raw);
  if (!o) return null;
  const strike = num(o.strikePrice);
  if (strike === null) return null;
  const osiKey = str(o.osiKey) ?? "";
  const underlying =
    str(o.optionRootSymbol) ?? str(o.symbol) ?? str(o.underlying) ?? "";
  const expiry =
    fallbackExpiry ?? parseExpiryFromOsi(osiKey) ?? "";
  if (!underlying || !expiry) return null;
  const right = parseRight(o.optionType, fallbackRight);
  const greeks = parseGreeks(o.OptionGreeks);
  return {
    underlying: underlying.toUpperCase(),
    osiKey,
    displaySymbol: str(o.displaySymbol) ?? osiKey,
    right,
    strike,
    expiry,
    bid: num(o.bid),
    ask: num(o.ask),
    last: num(o.lastPrice),
    bidSize: num(o.bidSize),
    askSize: num(o.askSize),
    openInterest: num(o.openInterest),
    ...greeks,
  };
}

export function parseOptionExpireDates(body: unknown, requested: string): OptionExpiriesResponse {
  const root = asRecord(body);
  const wrap = asRecord(root?.OptionExpireDateResponse) ?? root ?? {};
  const dates = asArray(wrap.ExpirationDate);
  const expiries: OptionExpiry[] = [];
  const seen = new Set<string>();
  for (const row of dates) {
    const r = asRecord(row);
    if (!r) continue;
    const year = num(r.year);
    const month = num(r.month);
    const day = num(r.day);
    if (year === null || month === null || day === null) continue;
    const expiry = parseExpiryYmd(Math.trunc(year), Math.trunc(month), Math.trunc(day));
    if (!expiry || seen.has(expiry)) continue;
    seen.add(expiry);
    expiries.push({
      year: Math.trunc(year),
      month: Math.trunc(month),
      day: Math.trunc(day),
      expiry,
      expiryType: str(r.expiryType),
    });
  }
  const env = etradeEnvName();
  return {
    symbol: requested.toUpperCase(),
    delayed: env !== "production",
    source: env === "production" ? "etrade" : "etrade-sandbox",
    expiries,
  };
}

export function parseOptionChain(body: unknown, requested: string): OptionChainSnapshot {
  const root = asRecord(body);
  const wrap = asRecord(root?.OptionChainResponse) ?? root ?? {};
  const selected = asRecord(wrap.SelectedED);
  const selExpiry =
    selected && num(selected.year) !== null && num(selected.month) !== null && num(selected.day) !== null
      ? parseExpiryYmd(
          Math.trunc(num(selected.year) as number),
          Math.trunc(num(selected.month) as number),
          Math.trunc(num(selected.day) as number),
        )
      : null;
  const pairs = asArray(wrap.OptionPair);
  const legs: OptionLeg[] = [];
  let underlying = "";
  let expiry = selExpiry ?? "";
  for (const pair of pairs) {
    const p = asRecord(pair);
    if (!p) continue;
    const call = parseOptionLeg(p.Call, "C", selExpiry);
    const put = parseOptionLeg(p.Put, "P", selExpiry);
    if (call) {
      legs.push(call);
      if (!underlying) underlying = call.underlying;
      if (!expiry) expiry = call.expiry;
    }
    if (put) {
      legs.push(put);
      if (!underlying) underlying = put.underlying;
      if (!expiry) expiry = put.expiry;
    }
  }
  const env = etradeEnvName();
  return {
    symbol: requested.toUpperCase(),
    underlying: (underlying || requested).toUpperCase(),
    expiry,
    delayed: env !== "production",
    source: env === "production" ? "etrade" : "etrade-sandbox",
    chainType: "CALLPUT",
    legs,
  };
}

export async function fetchOptionExpiries(
  symbol: string,
): Promise<
  | { ok: true; data: OptionExpiriesResponse }
  | { ok: false; status: number; error: string }
> {
  const sym = symbol.trim().toUpperCase();
  if (!isOptionUnderlying(sym)) {
    return { ok: false, status: 400, error: "symbol must be a ticker" };
  }
  const now = Date.now();
  const hit = expiryCache.get(sym);
  if (hit && now - hit.at < ETRADE_CACHE_MS) return { ok: true, data: hit.value };
  const creds = loadEtradeCreds();
  if ("error" in creds) return { ok: false, status: creds.status, error: creds.error };
  const got = await etradeGetJson("/v1/market/optionexpiredate", { symbol: sym }, creds);
  if (!got.ok) return got;
  const data = parseOptionExpireDates(got.body, sym);
  expiryCache.set(sym, { at: now, value: data });
  return { ok: true, data };
}

export type ChainQuery = {
  symbol: string;
  expiryYear?: number;
  expiryMonth?: number;
  expiryDay?: number;
  expiry?: string;
  noOfStrikes?: number;
};

export function parseYmd(raw: string): { year: number; month: number; day: number } | null {
  const m = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}


export function uniqueStrikes(legs: OptionLeg[]): number {
  return new Set(legs.map((l) => l.strike)).size;
}

/** Sandbox often returns a single strike (AAPL). Paper verticals need two. */
export function applySandboxVerticalFallback(
  data: OptionChainSnapshot,
  fixtureBody: unknown = sandboxOptionChainJson,
  requested = data.symbol,
): OptionChainSnapshot {
  if (uniqueStrikes(data.legs) >= 2) return data;
  const widened = parseOptionChain(fixtureBody, requested);
  return { ...widened, source: "etrade-sandbox" };
}

export async function fetchOptionChain(
  q: ChainQuery,
): Promise<
  | { ok: true; data: OptionChainSnapshot }
  | { ok: false; status: number; error: string }
> {
  const sym = q.symbol.trim().toUpperCase();
  if (!isOptionUnderlying(sym)) {
    return { ok: false, status: 400, error: "symbol must be a ticker" };
  }
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
  const cacheKey = `${sym}:${year}-${month}-${day}:${q.noOfStrikes ?? ""}`;
  const now = Date.now();
  const hit = chainCache.get(cacheKey);
  if (hit && now - hit.at < ETRADE_CACHE_MS) return { ok: true, data: hit.value };
  const creds = loadEtradeCreds();
  if ("error" in creds) return { ok: false, status: creds.status, error: creds.error };
  const query: Record<string, string> = {
    symbol: sym,
    expiryYear: String(year),
    expiryMonth: String(month),
    expiryDay: String(day),
    includeWeekly: "true",
    chainType: "CALLPUT",
  };
  query.noOfStrikes = String(q.noOfStrikes && q.noOfStrikes > 0 ? q.noOfStrikes : 16);
  const got = await etradeGetJson("/v1/market/optionchains", query, creds);
  if (!got.ok) return got;
  let data = parseOptionChain(got.body, sym);
  if (creds.env === "sandbox" && uniqueStrikes(data.legs) < 2) {
    data = applySandboxVerticalFallback(data, sandboxOptionChainJson, sym);
  }
  chainCache.set(cacheKey, { at: now, value: data });
  return { ok: true, data };
}

export function findLeg(
  legs: OptionLeg[],
  opts: { osiKey?: string; strike?: number; right?: OptionRight; expiry?: string },
): OptionLeg | undefined {
  return legs.find((leg) => {
    if (opts.osiKey && leg.osiKey !== opts.osiKey) return false;
    if (opts.right && leg.right !== opts.right) return false;
    if (opts.expiry && leg.expiry !== opts.expiry) return false;
    if (opts.strike !== undefined && Math.abs(leg.strike - opts.strike) > 1e-6) return false;
    return true;
  });
}
