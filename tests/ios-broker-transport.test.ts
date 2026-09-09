import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT,
  BROKER_REQUEST_TIMEOUT_SEC,
  BROKER_RESOURCE_TIMEOUT_SEC,
  NSURL_ERROR_TIMED_OUT,
  isTimeoutError,
  performWithTimeoutRetry,
  shouldRetryTransport,
} from "./ios-broker-transport";

const transportSwift = readFileSync(
  resolve("ios/EventGate/BrokerTransport.swift"),
  "utf8",
);
const apiSwift = readFileSync(resolve("ios/EventGate/BrokerAPI.swift"), "utf8");
const statusSwift = readFileSync(
  resolve("ios/EventGate/StatusController.swift"),
  "utf8",
);
const contentSwift = readFileSync(
  resolve("ios/EventGate/ContentView.swift"),
  "utf8",
);
const activityView = readFileSync(
  resolve("ios/EventGate/ActivityLogView.swift"),
  "utf8",
);
const pbx = readFileSync(
  resolve("ios/EventGate.xcodeproj/project.pbxproj"),
  "utf8",
);

describe("BrokerTransport timeout/retry helper", () => {
  it("retries once on transport timeout and not on other errors", () => {
    expect(isTimeoutError({ code: "timedOut" })).toBe(true);
    expect(isTimeoutError({ code: NSURL_ERROR_TIMED_OUT, domain: "NSURLErrorDomain" })).toBe(
      true,
    );
    expect(isTimeoutError({ code: "networkConnectionLost" })).toBe(false);

    expect(shouldRetryTransport({ code: "timedOut" }, 1)).toBe(true);
    expect(shouldRetryTransport({ code: "timedOut" }, 2)).toBe(false);
    expect(shouldRetryTransport({ code: "cannotConnectToHost" }, 1)).toBe(false);
    expect(BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT).toBe(1);
  });

  it("performs one automatic retry on timeout then surfaces the error", async () => {
    const calls: string[] = [];
    const ok = await performWithTimeoutRetry(async () => {
      calls.push("try");
      if (calls.length === 1) {
        const err = new Error("The request timed out.");
        Object.assign(err, { code: "timedOut" });
        throw err;
      }
      return { ok: true, path: "/api/status" };
    });
    expect(ok).toEqual({ ok: true, path: "/api/status" });
    expect(calls).toHaveLength(2);

    const twice: string[] = [];
    await expect(
      performWithTimeoutRetry(async () => {
        twice.push("try");
        const err = new Error("The request timed out.");
        Object.assign(err, { code: "timedOut" });
        throw err;
      }),
    ).rejects.toThrow("The request timed out.");
    expect(twice).toHaveLength(2);
  });

  it("does not retry HTTP/auth failures or non-timeout transport errors", async () => {
    let hostCalls = 0;
    await expect(
      performWithTimeoutRetry(async () => {
        hostCalls += 1;
        const err = new Error("Could not connect to the server.");
        Object.assign(err, { code: "cannotConnectToHost" });
        throw err;
      }),
    ).rejects.toThrow("Could not connect to the server.");
    expect(hostCalls).toBe(1);

    let httpCalls = 0;
    const http = await performWithTimeoutRetry(async () => {
      httpCalls += 1;
      return { status: 200, gateEnabled: true };
    });
    expect(http).toEqual({ status: 200, gateEnabled: true });
    expect(httpCalls).toBe(1);
  });
});

describe("iOS BrokerAPI session wiring", () => {
  it("uses an injectable dedicated URLSession with short timeouts, not shared", () => {
    expect(existsSync(resolve("ios/EventGate/BrokerTransport.swift"))).toBe(true);
    expect(transportSwift).toContain("protocol BrokerHTTPPerforming");
    expect(transportSwift).toContain("URLSessionConfiguration.ephemeral");
    expect(transportSwift).toContain("waitsForConnectivity = false");
    expect(transportSwift).toContain(
      `static let requestTimeout: TimeInterval = ${BROKER_REQUEST_TIMEOUT_SEC}`,
    );
    expect(transportSwift).toContain(
      `static let resourceTimeout: TimeInterval = ${BROKER_RESOURCE_TIMEOUT_SEC}`,
    );
    expect(transportSwift).toContain(
      `static let extraAttemptsOnTimeout = ${BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT}`,
    );
    expect(transportSwift).toContain("urlError.code == .timedOut");
    expect(transportSwift).toContain("shouldRetry");
    expect(transportSwift).not.toContain("URLSession.shared");
    expect(BROKER_REQUEST_TIMEOUT_SEC).toBeLessThanOrEqual(15);
    expect(BROKER_RESOURCE_TIMEOUT_SEC).toBeGreaterThanOrEqual(
      BROKER_REQUEST_TIMEOUT_SEC,
    );

    expect(apiSwift).toContain("var http: any BrokerHTTPPerforming");
    expect(apiSwift).toContain("http: any BrokerHTTPPerforming = BrokerTransport.session");
    expect(apiSwift).toContain("BrokerTransport.data(for: request, using: http)");
    expect(apiSwift).toContain("BrokerTransport.applyTimeouts");
    expect(apiSwift).toContain("Authorization");
    expect(apiSwift).toContain("Bearer");
    expect(apiSwift).toContain("/api/status");
    expect(apiSwift).toContain("/api/auth/login");
    expect(apiSwift).toContain("JSONDecoder().decode");
    expect(apiSwift).not.toContain("URLSession.shared");
    expect(apiSwift).not.toContain("waitsForConnectivity = true");

    expect(pbx).toContain("BrokerTransport.swift");
  });

  it("does not block first paint on GET /api/activity", () => {
    expect(contentSwift).not.toContain("activity.reload");
    expect(contentSwift).toContain("status.startPolling()");
    expect(statusSwift).not.toContain("/api/activity");
    expect(statusSwift).toContain("refreshInFlight");
    expect(activityView).toContain("await activity.reload()");
  });
});
