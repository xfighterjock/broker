import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path, { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { USAGE, run } from "../scripts/etrade-oauth.mjs";

const CONSUMER_KEY = "ck-prod-TESTKEY";
const CONSUMER_SECRET = "cs-prod-TESTSECRET";
const ACCESS_TOKEN = "at-prod-TESTTOKEN";
const ACCESS_SECRET = "as-prod-TESTSECRET";
const NEW_TOKEN = "at-prod-NEWTOKEN";
const NEW_SECRET = "as-prod-NEWSECRET";
const LEAKED = "leaked-oauth-token-SHOULD-NOT-PRINT";

const SECRET_VALUES = [
  CONSUMER_KEY,
  CONSUMER_SECRET,
  ACCESS_TOKEN,
  ACCESS_SECRET,
  NEW_TOKEN,
  NEW_SECRET,
  LEAKED,
];

function mockResponse(status: number, body: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function writeEnv(dir: string, extras: Record<string, string> = {}) {
  const file = path.join(dir, ".env.etrade");
  const rows: Record<string, string> = {
    ETRADE_ENV: "production",
    ETRADE_PROD_KEY: CONSUMER_KEY,
    ETRADE_PROD_SECRET: CONSUMER_SECRET,
    ETRADE_PROD_ACCESS_TOKEN: ACCESS_TOKEN,
    ETRADE_PROD_ACCESS_SECRET: ACCESS_SECRET,
    ...extras,
  };
  const text = Object.entries(rows)
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  writeFileSync(file, `${text}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

describe("etrade-oauth renew", () => {
  const dirs: string[] = [];

  afterEach(() => {
    while (dirs.length) {
      const dir = dirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function tmpDir() {
    const dir = mkdtempSync(path.join(tmpdir(), "etrade-oauth-"));
    dirs.push(dir);
    return dir;
  }

  async function runRenew(
    envFile: string,
    fetchImpl: ReturnType<typeof vi.fn>,
    argv: string[] = ["renew", "--env", "production"],
  ) {
    const logs: string[] = [];
    const errs: string[] = [];
    const open = vi.fn();
    const code = await run(argv, {
      envFile,
      fetch: fetchImpl,
      open,
      log: (m: string) => logs.push(String(m)),
      error: (m: string) => errs.push(String(m)),
    });
    const output = [...logs, ...errs].join("\n");
    return { code, logs, errs, output, open, fetchImpl };
  }

  function expectNoSecrets(output: string) {
    for (const secret of SECRET_VALUES) {
      expect(output).not.toContain(secret);
    }
    expect(output).not.toMatch(/us\.etrade\.com\/e\/t\/etws\/authorize\?key=/);
  }

  it("upserts new token fields, chmod 600, exit 0, and prints no secrets", async () => {
    const envFile = writeEnv(tmpDir());
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.etrade.com/oauth/renew_access_token");
      return mockResponse(200, `oauth_token=${NEW_TOKEN}&oauth_token_secret=${NEW_SECRET}`);
    });
    const { code, logs, output, open, fetchImpl: fetchFn } = await runRenew(envFile, fetchImpl);
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/renewed production access token/);
    expectNoSecrets(output);
    expect(open).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const init = fetchFn.mock.calls[0][1] as { method?: string; headers?: { Authorization?: string } };
    expect(init.method).toBe("GET");
    expect(init.headers?.Authorization).toMatch(/^OAuth /);
    expect(init.headers?.Authorization).toContain(`oauth_token="${ACCESS_TOKEN}"`);
    expect(init.headers?.Authorization).not.toContain("oauth_verifier");
    const written = readFileSync(envFile, "utf8");
    expect(written).toContain(`ETRADE_PROD_ACCESS_TOKEN=${NEW_TOKEN}`);
    expect(written).toContain(`ETRADE_PROD_ACCESS_SECRET=${NEW_SECRET}`);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
  });

  it("keeps the existing token when the body has no new token fields", async () => {
    const envFile = writeEnv(tmpDir());
    const before = readFileSync(envFile, "utf8");
    const fetchImpl = vi.fn(async () => mockResponse(200, "Access Token has been renewed"));
    const { code, logs, output, open } = await runRenew(envFile, fetchImpl);
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/renewed production access token/);
    expectNoSecrets(output);
    expect(open).not.toHaveBeenCalled();
    expect(readFileSync(envFile, "utf8")).toBe(before);
  });

  it("keeps the existing token on HTTP success with an empty body", async () => {
    const envFile = writeEnv(tmpDir());
    const before = readFileSync(envFile, "utf8");
    const fetchImpl = vi.fn(async () => mockResponse(200, ""));
    const { code, output } = await runRenew(envFile, fetchImpl);
    expect(code).toBe(0);
    expectNoSecrets(output);
    expect(readFileSync(envFile, "utf8")).toBe(before);
  });

  it("exits non-zero on 401 and never prints secrets from the body", async () => {
    const envFile = writeEnv(tmpDir());
    const fetchImpl = vi.fn(async () =>
      mockResponse(401, `oauth_token=${LEAKED}&oauth_token_secret=${LEAKED}`),
    );
    const { code, errs, output, open } = await runRenew(envFile, fetchImpl);
    expect(code).not.toBe(0);
    expect(code).toBe(1);
    expect(errs.join("\n")).toMatch(/renew failed: HTTP 401/);
    expectNoSecrets(output);
    expect(open).not.toHaveBeenCalled();
    expect(readFileSync(envFile, "utf8")).toContain(`ETRADE_PROD_ACCESS_TOKEN=${ACCESS_TOKEN}`);
  });

  it("exits 2 and does not call the network when the access token is missing", async () => {
    const envFile = writeEnv(tmpDir(), {
      ETRADE_PROD_ACCESS_TOKEN: "",
      ETRADE_PROD_ACCESS_SECRET: "",
    });
    const fetchImpl = vi.fn(async () => {
      throw new Error("network should not be called");
    });
    const { code, errs, output } = await runRenew(envFile, fetchImpl);
    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(errs.join("\n")).toMatch(/missing access token/);
    expectNoSecrets(output);
  });

  it("documents renew in usage output", async () => {
    const logs: string[] = [];
    const errs: string[] = [];
    const fetchImpl = vi.fn();
    const code = await run([], {
      fetch: fetchImpl,
      log: (m: string) => logs.push(String(m)),
      error: (m: string) => errs.push(String(m)),
    });
    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    const usage = [...logs, ...errs].join("\n");
    expect(usage).toMatch(/renew/);
    expect(USAGE).toMatch(/renew/);
    expect(usage).toMatch(USAGE);
  });

  it("never calls request, access, order, or account endpoints from renew", async () => {
    const envFile = writeEnv(tmpDir());
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe("https://api.etrade.com/oauth/renew_access_token");
      return mockResponse(200, "");
    });
    const { code, open } = await runRenew(envFile, fetchImpl);
    expect(code).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const called = String(fetchImpl.mock.calls[0][0]);
    expect(called).not.toContain("/oauth/request_token");
    expect(called).not.toMatch(/\/oauth\/access_token$/);
    expect(called).not.toContain("/v1/order");
    expect(called).not.toContain("/v1/accounts");
  });
});

describe("etrade-oauth script stays chain-only", () => {
  it("usage comment includes renew and the file never hits order APIs", () => {
    const script = readFileSync(resolve("scripts/etrade-oauth.mjs"), "utf8");
    expect(script).toMatch(/renew_access_token/);
    expect(script).toMatch(/node scripts\/etrade-oauth\.mjs renew/);
    expect(script).not.toMatch(/\/v1\/order/);
    expect(script).not.toMatch(/placeOrder/i);
    expect(script).not.toMatch(/previewOrder/i);
    expect(script).not.toMatch(/\/v1\/accounts/);
  });
});
