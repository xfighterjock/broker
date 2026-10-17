import { describe, expect, it } from "vitest";
import type { OptionExpiry } from "../shared/types";
import { expirySkipReason, formatOptionFetchUnavailable } from "../server/src/autopilot";

const oct9: OptionExpiry = {
  year: 2026,
  month: 10,
  day: 9,
  expiry: "2026-10-09",
  expiryType: "MONTHLY",
};

describe("option expiry / chain fetch diagnostics", () => {
  it("formats fetch failures with the error and optional status", () => {
    expect(formatOptionFetchUnavailable("expiries", { error: "auth required" })).toBe(
      "option expiries unavailable: auth required",
    );
    expect(formatOptionFetchUnavailable("expiries", { error: "empty body", status: 502 })).toBe(
      "option expiries unavailable: empty body (status 502)",
    );
    expect(formatOptionFetchUnavailable("chain", { error: "timeout", status: 504 })).toBe(
      "option chain unavailable: timeout (status 504)",
    );
  });

  it("distinguishes empty list from nonempty-but-outside the 30–45 DTE band", () => {
    const now = new Date("2026-09-03T13:50:00.000Z");
    expect(expirySkipReason([], now)).toBe("option expiries empty");
    const tooFar: OptionExpiry = {
      year: 2026,
      month: 12,
      day: 18,
      expiry: "2026-12-18",
      expiryType: "MONTHLY",
    };
    expect(expirySkipReason([tooFar], now)).toMatch(/^no 30–45 DTE expiry \(1 listed, nearest \d+ DTE\)$/);
    expect(expirySkipReason([oct9], now)).toBeNull();
  });
});
