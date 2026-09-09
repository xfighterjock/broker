import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT,
  BROKER_REQUEST_TIMEOUT_SEC,
  BROKER_RESOURCE_TIMEOUT_SEC,
  NSURL_ERROR_TIMED_OUT,
  hangUntilAborted,
  isTimeoutError,
  performWithTimeout,
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
const appSwift = readFileSync(resolve("ios/EventGate/EventGateApp.swift"), "utf8");
const delegateSwift = readFileSync(
  resolve("ios/EventGate/AppDelegate.swift"),
  "utf8",
);
const authSwift = readFileSync(
  resolve("ios/EventGate/AuthController.swift"),
  "utf8",
);
const essentialsSwift = readFileSync(
  resolve("ios/EventGate/EssentialsView.swift"),
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

function launchMethod(src: string): string {
  const start = src.indexOf("didFinishLaunchingWithOptions");
  const end = src.indexOf("startFirebaseAfterFirstFrame");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe("BrokerTransport hard-cancel of a blackholed connect", () => {
  it("retries a cancelled first attempt once on a fresh session", () => {
    expect(isTimeoutError({ code: "timedOut" })).toBe(true);
    expect(isTimeoutError({ code: NSURL_ERROR_TIMED_OUT, domain: "NSURLErrorDomain" })).toBe(
      true,
    );
    expect(isTimeoutError({ code: "cancelled" })).toBe(true);
    expect(shouldRetryTransport({ code: "timedOut" }, 1)).toBe(true);
    expect(shouldRetryTransport({ code: "timedOut" }, 2)).toBe(false);
    expect(BROKER_EXTRA_ATTEMPTS_ON_TIMEOUT).toBe(1);
  });

  it("cancels a hung connect and retries once on a fresh session", async () => {
    const sessions: number[] = [];
    let calls = 0;
    const started = Date.now();
    const result = await performWithTimeout(
      async ({ sessionId, signal }) => {
        calls += 1;
        sessions.push(sessionId);
        if (calls === 1) return hangUntilAborted(signal);
        return { ok: true };
      },
      { timeoutMs: 40 },
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(sessions).toEqual([1, 2]);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("fails after two cancelled attempts instead of waiting for a path-update", async () => {
    let calls = 0;
    const started = Date.now();
    await expect(
      performWithTimeout(
        async ({ signal }) => {
          calls += 1;
          return hangUntilAborted(signal);
        },
        { timeoutMs: 30 },
      ),
    ).rejects.toThrow("The request timed out.");
    expect(calls).toBe(2);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("does not retry a successful first attempt", async () => {
    let calls = 0;
    expect(
      await performWithTimeout(async () => {
        calls += 1;
        return { ok: true };
      }, { timeoutMs: 40 }),
    ).toEqual({ ok: true });
    expect(calls).toBe(1);
  });
});

describe("iOS cold start first paint", () => {
  it("does not configure Firebase or attach push before the window", () => {
    const launch = launchMethod(delegateSwift);
    expect(launch).toContain("UNUserNotificationCenter.current().delegate = self");
    expect(launch).not.toContain("FirebaseApp.configure");
    expect(launch).not.toContain("PushController.shared.attach");
    expect(launch).not.toContain("registerForRemoteNotifications");
    expect(delegateSwift).toContain("startFirebaseAfterFirstFrame");
    expect(delegateSwift).toMatch(
      /func startFirebaseAfterFirstFrame[\s\S]*FirebaseApp\.configure/,
    );
    expect(appSwift).toContain("startFirebaseAfterFirstFrame");
    expect(appSwift).toContain(".task");
  });

  it("does not block the MainActor on Firebase configure or APNs/FCM attach", () => {
    expect(delegateSwift).toContain("Task.detached");
    expect(delegateSwift).toMatch(
      /Task\.detached[\s\S]*FirebaseApp\.configure/,
    );
    expect(delegateSwift).not.toMatch(
      /@MainActor\s*\n\s*func startFirebaseAfterFirstFrame/,
    );
    const taskBlocks = appSwift.split(".task");
    expect(
      taskBlocks.some(
        (block) =>
          block.includes("status.startPolling") &&
          !block.includes("startFirebaseAfterFirstFrame"),
      ),
    ).toBe(true);
    expect(
      taskBlocks.some(
        (block) =>
          block.includes("startFirebaseAfterFirstFrame") &&
          !block.includes("status.startPolling"),
      ),
    ).toBe(true);
  });

  it("paints login or last session without waiting on status or FCM", () => {
    expect(authSwift).toContain("restoreSessionOnLaunch()");
    expect(authSwift).toMatch(
      /init\(\) \{[\s\S]*evaluateBiometrics\(\)[\s\S]*restoreSessionOnLaunch\(\)/,
    );
    expect(statusSwift).toContain("lastSnapshotKey");
    expect(statusSwift).toContain("JSONDecoder().decode(StatusSnapshot.self");
    expect(contentSwift).not.toContain("restoreSessionOnLaunch");
    expect(contentSwift).not.toContain("activity.reload");
    expect(contentSwift).toContain("status.startPolling()");
    expect(appSwift).toContain("status.startPolling()");
    expect(statusSwift).not.toContain("/api/activity");
    expect(activityView).toContain("await activity.reload()");
    expect(essentialsSwift).toContain("Waiting for live status");
    expect(essentialsSwift).toContain("status.lastError");
  });

  it("cancels the URLSession task after a few seconds and retries on a fresh session", () => {
    expect(existsSync(resolve("ios/EventGate/BrokerTransport.swift"))).toBe(true);
    expect(transportSwift).toContain("protocol BrokerHTTPPerforming");
    expect(transportSwift).toContain("URLSessionConfiguration.ephemeral");
    expect(transportSwift).toContain("waitsForConnectivity = false");
    expect(transportSwift).toContain("extraAttemptsOnTimeout = 1");
    expect(transportSwift).toContain(
      `static let requestTimeout: TimeInterval = ${BROKER_REQUEST_TIMEOUT_SEC}`,
    );
    expect(transportSwift).toContain(
      `static let resourceTimeout: TimeInterval = ${BROKER_RESOURCE_TIMEOUT_SEC}`,
    );
    expect(transportSwift).toContain("Task.sleep");
    expect(transportSwift).toContain("invalidateAndCancel");
    expect(transportSwift).toContain("task?.cancel()");
    expect(transportSwift).toContain("makeSession()");
    expect(transportSwift).toMatch(/for attempt in 1\.\.\.attempts/);
    expect(transportSwift).not.toMatch(/URLSession\.shared\.(data|download|upload)/);
    expect(BROKER_REQUEST_TIMEOUT_SEC).toBeLessThanOrEqual(10);
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
});
