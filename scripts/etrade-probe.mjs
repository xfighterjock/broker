#!/usr/bin/env node
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ENV_FILE = path.join(ROOT, ".env.etrade");

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
function oauthHeader(method, url, query, consumerKey, consumerSecret, token, tokenSecret) {
  const oauth = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: "1.0",
  };
  const params = { ...query, ...oauth };
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
async function etradeGet(base, rel, query, creds) {
  const url = `${base}${rel}`;
  const authorization = oauthHeader("GET", url, query, creds.key, creds.secret, creds.token, creds.tokenSecret);
  const q = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
    .join("&");
  const href = q ? `${url}?${q}` : url;
  const res = await fetch(href, { headers: { Authorization: authorization, Accept: "application/json" } });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 240); }
  return { status: res.status, body };
}

const env = loadDotenv(ENV_FILE);
const creds = {
  key: env.ETRADE_PROD_KEY,
  secret: env.ETRADE_PROD_SECRET,
  token: env.ETRADE_PROD_ACCESS_TOKEN,
  tokenSecret: env.ETRADE_PROD_ACCESS_SECRET,
};
if (!creds.key || !creds.secret || !creds.token || !creds.tokenSecret) throw new Error("prod creds incomplete");
const base = "https://api.etrade.com";

const exp = await etradeGet(base, "/v1/market/optionexpiredate", { symbol: "SPY" }, creds);
if (exp.status !== 200) {
  console.log("expiredate status", exp.status);
  process.exit(1);
}
const wrap = exp.body?.OptionExpireDateResponse || exp.body || {};
const dates = [].concat(wrap.ExpirationDate || []);
const today = new Date();
function dte(row) {
  const dt = new Date(Date.UTC(Number(row.year), Number(row.month) - 1, Number(row.day)));
  return Math.round((dt - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000);
}
const pick = dates
  .map((r) => ({ y: r.year, m: r.month, d: r.day, dte: dte(r) }))
  .filter((r) => r.dte >= 30 && r.dte <= 45)
  .sort((a, b) => a.dte - b.dte)[0] || dates.map((r) => ({ y: r.year, m: r.month, d: r.day, dte: dte(r) })).sort((a,b)=>a.dte-b.dte)[0];
console.log("expiries", dates.length, "picked", pick);

const chain = await etradeGet(
  base,
  "/v1/market/optionchains",
  {
    symbol: "SPY",
    expiryYear: String(pick.y),
    expiryMonth: String(pick.m),
    expiryDay: String(pick.d),
    includeWeekly: "true",
    chainType: "PUT",
    noOfStrikes: "8",
  },
  creds,
);
if (chain.status !== 200) {
  console.log("chain status", chain.status);
  process.exit(1);
}
const pairs = [].concat(chain.body?.OptionChainResponse?.OptionPair || chain.body?.OptionPair || []);
let n = 0, bid = 0, ask = 0, both = 0;
let sample = null;
for (const p of pairs) {
  for (const side of ["Put", "Call"]) {
    const leg = p?.[side];
    if (!leg) continue;
    n++;
    const b = Number(leg.bid);
    const a = Number(leg.ask);
    const hasB = Number.isFinite(b);
    const hasA = Number.isFinite(a);
    if (hasB) bid++;
    if (hasA) ask++;
    if (hasB && hasA) both++;
    if (!sample && hasB && hasA) sample = { strike: leg.strikePrice, bid: b, ask: a, last: leg.lastPrice };
  }
}
console.log("legs", n, "bid", bid, "ask", ask, "twoSided", both);
if (sample) console.log("sample", sample.strike, "bid", sample.bid, "ask", sample.ask);
