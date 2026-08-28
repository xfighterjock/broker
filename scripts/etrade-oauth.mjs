#!/usr/bin/env node
/**
 * E*TRADE OAuth 1.0a PIN handshake. Quotes/chains only. Never hits order APIs.
 * Usage:
 *   node scripts/etrade-oauth.mjs request [--env production|sandbox]
 *   node scripts/etrade-oauth.mjs access <PIN> [--env production|sandbox]
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, chmodSync, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENV_FILE = path.join(ROOT, ".env.etrade");
const TMP_FILE = path.join(ROOT, ".env.etrade.oauth-tmp");
const AUTH_URL = "https://us.etrade.com/e/t/etws/authorize";

function percentEncode(s) {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function loadDotenv(file) {
  const env = {};
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const i = t.indexOf("=");
    env[t.slice(0, i)] = t.slice(i + 1);
  }
  return env;
}

function upsertEnv(file, updates) {
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

function oauthHeader(method, url, extra, consumerKey, consumerSecret, token, tokenSecret) {
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

function parseQs(body) {
  const out = {};
  for (const part of String(body).trim().split("&")) {
    if (!part.includes("=")) continue;
    const i = part.indexOf("=");
    out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

async function oauthGet(url, extra, consumerKey, consumerSecret, token, tokenSecret) {
  const authorization = oauthHeader("GET", url, extra, consumerKey, consumerSecret, token, tokenSecret);
  const res = await fetch(url, { method: "GET", headers: { Authorization: authorization } });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${text.slice(0, 200)}`);
  }
  return parseQs(text);
}

function whichEnv(argv) {
  const i = argv.indexOf("--env");
  if (i >= 0 && argv[i + 1]) {
    const v = argv[i + 1].toLowerCase();
    if (v === "production" || v === "prod" || v === "live") return "production";
    return "sandbox";
  }
  return "production";
}

function credsFor(envFile, name) {
  const sandbox = name === "sandbox";
  const key = sandbox ? envFile.ETRADE_SANDBOX_KEY : envFile.ETRADE_PROD_KEY || envFile.ETRADE_KEY;
  const secret = sandbox ? envFile.ETRADE_SANDBOX_SECRET : envFile.ETRADE_PROD_SECRET || envFile.ETRADE_SECRET;
  if (!key || !secret) throw new Error(`${name} consumer key/secret missing in .env.etrade`);
  const base = sandbox ? "https://apisb.etrade.com" : "https://api.etrade.com";
  return { key, secret, base, name };
}

function openUrl(url) {
  spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const name = whichEnv(argv);
const env = loadDotenv(ENV_FILE);
const creds = credsFor(env, name);

if (cmd === "request") {
  const url = `${creds.base}/oauth/request_token`;
  const got = await oauthGet(url, { oauth_callback: "oob" }, creds.key, creds.secret, "", "");
  if (!got.oauth_token || !got.oauth_token_secret) {
    throw new Error("request_token missing oauth_token");
  }
  writeFileSync(
    TMP_FILE,
    `env=${creds.name}\noauth_token=${got.oauth_token}\noauth_token_secret=${got.oauth_token_secret}\n`,
    { mode: 0o600 },
  );
  chmodSync(TMP_FILE, 0o600);
  const href = `${AUTH_URL}?key=${encodeURIComponent(creds.key)}&token=${encodeURIComponent(got.oauth_token)}`;
  openUrl(href);
  console.log("opened E*TRADE authorize in your browser");
  console.log("after you approve, send the PIN (not the keys)");
} else if (cmd === "access") {
  const pin = argv.find((a, i) => i > 0 && !a.startsWith("--") && argv[i - 1] !== "--env");
  if (!pin) throw new Error("usage: node scripts/etrade-oauth.mjs access <PIN> --env production");
  if (!existsSync(TMP_FILE)) throw new Error("no request token; run request first");
  const tmp = loadDotenv(TMP_FILE);
  const url = `${creds.base}/oauth/access_token`;
  const got = await oauthGet(
    url,
    { oauth_verifier: pin },
    creds.key,
    creds.secret,
    tmp.oauth_token,
    tmp.oauth_token_secret,
  );
  if (!got.oauth_token || !got.oauth_token_secret) throw new Error("access_token missing oauth_token");
  const updates =
    creds.name === "sandbox"
      ? {
          ETRADE_ENV: "sandbox",
          ETRADE_SANDBOX_ACCESS_TOKEN: got.oauth_token,
          ETRADE_SANDBOX_ACCESS_SECRET: got.oauth_token_secret,
        }
      : {
          ETRADE_ENV: "production",
          ETRADE_PROD_ACCESS_TOKEN: got.oauth_token,
          ETRADE_PROD_ACCESS_SECRET: got.oauth_token_secret,
        };
  upsertEnv(ENV_FILE, updates);
  unlinkSync(TMP_FILE);
  console.log(`wrote ${creds.name} access token; .env.etrade mode 600`);
} else {
  console.error("usage: node scripts/etrade-oauth.mjs request|access <PIN> [--env production|sandbox]");
  process.exit(2);
}
