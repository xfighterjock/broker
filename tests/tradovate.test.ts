import { describe, expect, it } from "vitest";
import {
  assertDemoTradovateUrl,
  LiveTradovateRefusedError,
  TradovateDemoBroker,
} from "../server/src/tradovateBroker";

describe("TradovateDemoBroker live-host refuse", () => {
  it("cannot be constructed with live.tradovateapi.com", () => {
    expect(
      () => new TradovateDemoBroker({ baseUrl: "https://live.tradovateapi.com/v1" }),
    ).toThrow(LiveTradovateRefusedError);
    expect(
      () => new TradovateDemoBroker({ baseUrl: "https://live.tradovateapi.com/v1" }),
    ).toThrow(/live/i);
  });

  it("refuses any host containing live", () => {
    expect(
      () => new TradovateDemoBroker({ baseUrl: "https://demo-live.tradovateapi.com/v1" }),
    ).toThrow(LiveTradovateRefusedError);
    expect(
      () => new TradovateDemoBroker({ baseUrl: "https://livehost.example.com/v1" }),
    ).toThrow(/live/i);
  });

  it("constructs against the demo host", () => {
    const b = new TradovateDemoBroker({
      baseUrl: "https://demo.tradovateapi.com/v1",
    });
    expect(b.mode).toBe("demo");
    expect(b.stub).toBe(true);
    expect(b.baseUrl).toBe("https://demo.tradovateapi.com/v1");
  });

  it("defaults to demo URL", () => {
    const b = new TradovateDemoBroker();
    expect(b.baseUrl).toContain("demo.tradovateapi.com");
  });

  it("assertDemoTradovateUrl rejects http and unknown hosts", () => {
    expect(() => assertDemoTradovateUrl("http://demo.tradovateapi.com/v1")).toThrow(/https/);
    expect(() => assertDemoTradovateUrl("https://example.com/v1")).toThrow(/demo\.tradovateapi\.com/);
  });
});
