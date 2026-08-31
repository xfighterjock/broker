#!/usr/bin/env node
/**
 * E*TRADE OAuth 1.0a PIN handshake + access-token renew. Quotes/chains only. Never hits order APIs.
 * Usage:
 *   node scripts/etrade-oauth.mjs request [--env production|sandbox]
 *   node scripts/etrade-oauth.mjs access <PIN> [--env production|sandbox]
 *   node scripts/etrade-oauth.mjs renew [--env production|sandbox]
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENV_FILE = path.join(ROOT, ".env.etrade");
const TMP_FILE = path.join(ROOT, ".env.etrade.oauth-tmp");
const AUTH_URL = "https://us.etrade.com/e/t/etws/authorize";
export const USAGE =
  "usage: node scripts/etrade-oauth.mjs request|access <PIN>|renew [--env production|sandbox]";

export function percentEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export function loadDotenv(file) {
  const env = {};
  if (!existsSync(file)) throw new Error("missing credentials");
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}

export function upsertEnv(file, updates) {
  const orig = existsSync(file) ? readFileSync(file, "utf8") : "";
  const seen = new Set();
  const lines = orig.split(/\n/);
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) return line;
    const k = t.split("=", 1)[0];
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
  writeFileSync(file, text, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function oauthHeader(method, url, extra, consumerKey, consumerSecret, token, tokenSecret) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...extra,
  };
  if (token) oauth.oauth_token = token;
  const params = { ...oauth };
  const encoded = Object.keys(params)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`)
    .join("&");
  const base = `${method.toUpperCase()}&${percentEncode(url)}&${percentEncode(encoded)}`;
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret || "")}`;
  oauth.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  return (
    "OAuth " +
    Object.keys(oauth)
      .sort()
      .map((k) => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
      .join(", ")
  );
}

export function parseQs(body) {
  const out = {};
  for (const part of String(body).trim().split("&")) {
    if (!part.includes("=")) continue;
    const i = part.indexOf("=");
    out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

async function oauthGet(url, extra, consumerKey, consumerSecret, token, tokenSecret, fetchFn) {
  const authorization = oauthHeader("GET", url, extra, consumerKey, consumerSecret, token, tokenSecret);
  const res = await fetchFn(url, { method: "GET", headers: { Authorization: authorization } });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return { text, parsed: parseQs(text) };
}

export function whichEnv(argv) {
  const i = argv.indexOf("--env");
  if (i >= 0 && argv[i + 1]) {
    const v = argv[i + 1].toLowerCase();
    if (v === "production" || v === "prod" || v === "live") return "production";
    return "sandbox";
  }
  return "production";
}

export function credsFor(envFile, name) {
  const sandbox = name === "sandbox";
  const key = sandbox ? envFile.ETRADE_SANDBOX_KEY : envFile.ETRADE_PROD_KEY || envFile.ETRADE_KEY;
  const secret = sandbox ? envFile.ETRADE_SANDBOX_SECRET : envFile.ETRADE_PROD_SECRET || envFile.ETRADE_SECRET;
  if (!key || !secret) throw new Error("missing credentials");
  const base = sandbox ? "https://apisb.etrade.com" : "https://api.etrade.com";
  return { key, secret, base, name };
}

export function accessTokensFor(envFile, name) {
  const sandbox = name === "sandbox";
  const token = sandbox
    ? envFile.ETRADE_SANDBOX_ACCESS_TOKEN
    : envFile.ETRADE_PROD_ACCESS_TOKEN || envFile.ETRADE_ACCESS_TOKEN;
  const secret = sandbox
    ? envFile.ETRADE_SANDBOX_ACCESS_SECRET
    : envFile.ETRADE_PROD_ACCESS_SECRET || envFile.ETRADE_ACCESS_SECRET;
  return { token, secret };
}

function accessUpdates(name, token, secret) {
  return name === "sandbox"
    ? {
        ETRADE_ENV: "sandbox",
        ETRADE_SANDBOX_ACCESS_TOKEN: token,
        ETRADE_SANDBOX_ACCESS_SECRET: secret,
      }
    : {
        ETRADE_ENV: "production",
        ETRADE_PROD_ACCESS_TOKEN: token,
        ETRADE_PROD_ACCESS_SECRET: secret,
      };
}

function openUrl(url) {
  spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
}

function looksLikeSecret(value) {
  return typeof value === "string" && value.length > 0;
}

/** Strip secret-like values from a message. Never echo tokens, keys, PINs, or authorize URLs. */
export function publicError(err, cmd = "oauth") {
  const status = err && (err.status || err.statusCode);
  if (status) return `${cmd} failed: HTTP ${status}`;
  const msg = err && err.message ? String(err.message) : "";
  if (msg === "missing credentials" || msg === "missing access token") {
    return `${cmd} failed: ${msg}`;
  }
  if (msg.startsWith("HTTP ")) return `${cmd} failed: ${msg}`;
  return `${cmd} failed`;
}

export async function run(argv, opts = {}) {
  const log = opts.log ?? console.log;
  const error = opts.error ?? console.error;
  const fetchFn = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const openFn = opts.open ?? openUrl;
  const envFile = opts.envFile ?? ENV_FILE;
  const tmpFile = opts.tmpFile ?? TMP_FILE;

  const cmd = argv[0];
  const name = whichEnv(argv);
  if (cmd !== "request" && cmd !== "access" && cmd !== "renew") {
    error(USAGE);
    return 2;
  }

  let env;
  try {
    env = loadDotenv(envFile);
  } catch {
    error(`${cmd} failed: missing credentials`);
    return 2;
  }

  let creds;
  try {
    creds = credsFor(env, name);
  } catch {
    error(`${cmd} failed: missing credentials`);
    return 2;
  }

  try {
    if (cmd === "request") {
      const url = `${creds.base}/oauth/request_token`;
      const { parsed: got } = await oauthGet(url, { oauth_callback: "oob" }, creds.key, creds.secret, "", "", fetchFn);
      if (!got.oauth_token || !got.oauth_token_secret) {
        error("request failed");
        return 1;
      }
      writeFileSync(
        tmpFile,
        `env=${creds.name}\noauth_token=${got.oauth_token}\noauth_token_secret=${got.oauth_token_secret}\n`,
        { mode: 0o600 },
      );
      chmodSync(tmpFile, 0o600);
      const href = `${AUTH_URL}?key=${encodeURIComponent(creds.key)}&token=${encodeURIComponent(got.oauth_token)}`;
      openFn(href);
      log("opened E*TRADE authorize in your browser");
      log("after you approve, send the PIN (not the keys)");
      return 0;
    }

    if (cmd === "access") {
      const pin = argv.find((a, i) => i > 0 && !a.startsWith("--") && argv[i - 1] !== "--env");
      if (!pin) {
        error("usage: node scripts/etrade-oauth.mjs access <PIN> [--env production|sandbox]");
        return 2;
      }
      if (!existsSync(tmpFile)) {
        error("access failed: no request token; run request first");
        return 1;
      }
      const tmp = loadDotenv(tmpFile);
      const url = `${creds.base}/oauth/access_token`;
      const { parsed: got } = await oauthGet(
        url,
        { oauth_verifier: pin },
        creds.key,
        creds.secret,
        tmp.oauth_token,
        tmp.oauth_token_secret,
        fetchFn,
      );
      if (!got.oauth_token || !got.oauth_token_secret) {
        error("access failed");
        return 1;
      }
      upsertEnv(envFile, accessUpdates(creds.name, got.oauth_token, got.oauth_token_secret));
      unlinkSync(tmpFile);
      log(`wrote ${creds.name} access token; .env.etrade mode 600`);
      return 0;
    }

    // renew: GET /oauth/renew_access_token signed with the current access token.
    // E*TRADE docs: idle tokens (~2h) can be reactivated; midnight US/Eastern still needs a new PIN.
    const access = accessTokensFor(env, name);
    if (!access.token || !access.secret) {
      error("renew failed: missing access token");
      return 2;
    }
    const url = `${creds.base}/oauth/renew_access_token`;
    const { parsed: got } = await oauthGet(url, {}, creds.key, creds.secret, access.token, access.secret, fetchFn);
    if (looksLikeSecret(got.oauth_token) && looksLikeSecret(got.oauth_token_secret)) {
      upsertEnv(envFile, accessUpdates(creds.name, got.oauth_token, got.oauth_token_secret));
    }
    log(`renewed ${creds.name} access token`);
    return 0;
  } catch (err) {
    error(publicError(err, cmd));
    return 1;
  }
}

function isCliMain() {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(argvPath);
  } catch {
    return false;
  }
}

if (isCliMain()) {
  run(process.argv.slice(2))
    .then((code) => {
      if (code) process.exit(code);
    })
    .catch(() => {
      console.error("oauth failed");
      process.exit(1);
    });
}
