import http from "node:http";
import { describe, expect, it } from "vitest";
import { seedEvents, zonedTimeToUtc } from "../shared/clock";
import {
  computeMarketSession,
  easterSunday,
  marketSessionBanner,
  nyseDayOn,
} from "../shared/marketSession";
import type { CalendarEvent, StatusSnapshot } from "../shared/types";
import { buildApp } from "../server/src/app";
import type { AppConfig } from "../server/src/config";
import { GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { StatusHub } from "../server/src/wsHub";

function atEt(year: number, month: number, day: number, hour = 10, minute = 0) {
  return computeMarketSession(zonedTimeToUtc(year, month, day, hour, minute, 0));
}

describe("NYSE cash holiday calendar", () => {
  it("closes Labor Day 2026-09-07 with holidayName Labor Day", () => {
    const s = atEt(2026, 9, 7, 10, 0);
    expect(s.cashOpen).toBe(false);
    expect(s.closedReason).toBe("holiday");
    expect(s.holidayName).toBe("Labor Day");
    expect(s.asOfEt).toMatch(/2026-09-07/);
    expect(s.nextOpenEt).toMatch(/2026-09-08 09:30/);
    expect(marketSessionBanner(s)).toBe("US cash market closed — Labor Day");
  });

  it("observes Independence Day 2026 (Saturday) on Friday 2026-07-03", () => {
    const observed = atEt(2026, 7, 3, 10, 0);
    expect(observed.cashOpen).toBe(false);
    expect(observed.closedReason).toBe("holiday");
    expect(observed.holidayName).toBe("Independence Day");
    expect(nyseDayOn(2026, 7, 4)?.kind).not.toBe("holiday");
    expect(atEt(2026, 7, 4, 10, 0).closedReason).toBe("weekend");
  });

  it("treats Saturday and Sunday as weekend closes", () => {
    const sat = atEt(2026, 9, 5, 12, 0);
    const sun = atEt(2026, 9, 6, 12, 0);
    expect(sat.cashOpen).toBe(false);
    expect(sat.closedReason).toBe("weekend");
    expect(sat.holidayName).toBeNull();
    expect(marketSessionBanner(sat)).toBe("US cash market closed — weekend");
    expect(sun.cashOpen).toBe(false);
    expect(sun.closedReason).toBe("weekend");
    expect(marketSessionBanner(sun)).toBe("US cash market closed — weekend");
  });

  it("is cash-open on a normal Tuesday–Friday session (2026-09-08)", () => {
    const tue = atEt(2026, 9, 8, 10, 0);
    expect(tue.cashOpen).toBe(true);
    expect(tue.closedReason).toBeNull();
    expect(tue.holidayName).toBeNull();
    expect(marketSessionBanner(tue)).toBeNull();
  });

  it("keeps other 2026 full-day holidays", () => {
    expect(easterSunday(2026)).toEqual({ month: 4, day: 5 });
    expect(nyseDayOn(2026, 1, 1)?.name).toBe("New Year's Day");
    expect(nyseDayOn(2026, 1, 19)?.name).toBe("Martin Luther King Jr. Day");
    expect(nyseDayOn(2026, 2, 16)?.name).toBe("Presidents' Day");
    expect(nyseDayOn(2026, 4, 3)?.name).toBe("Good Friday");
    expect(nyseDayOn(2026, 5, 25)?.name).toBe("Memorial Day");
    expect(nyseDayOn(2026, 6, 19)?.name).toBe("Juneteenth");
    expect(nyseDayOn(2026, 11, 26)?.name).toBe("Thanksgiving");
    expect(nyseDayOn(2026, 12, 25)?.name).toBe("Christmas");
  });

  it("notes early-close days without treating them as full holidays", () => {
    const afterTg = atEt(2026, 11, 27, 10, 0);
    expect(afterTg.cashOpen).toBe(true);
    expect(afterTg.closedReason).toBe("early_close");
    expect(afterTg.holidayName).toBe("day after Thanksgiving");
    expect(marketSessionBanner(afterTg)).toBe(
      "US cash market early close — day after Thanksgiving",
    );

    const eve = atEt(2026, 12, 24, 10, 0);
    expect(eve.cashOpen).toBe(true);
    expect(eve.closedReason).toBe("early_close");
    expect(eve.holidayName).toBe("Christmas Eve");
  });
});

function testCfg(): AppConfig {
  return {
    databaseUrl: "postgres://x",
    redisUrl: "redis://127.0.0.1:6379",
    port: 0,
    bind: "127.0.0.1",
    gatePassword: undefined,
    tradingMode: "mock",
    nodeEnv: "test",
    cookieSecure: false,
    authMode: "cookie",
    tradovateBaseUrl: undefined,
  };
}

function makeTestApp(events: CalendarEvent[] = seedEvents()) {
  const broker = new MockBroker();
  const engine = new GateEngine(broker, () => new Date(), () => events, {
    enabled: false,
    dailyLossUsd: 500,
  });
  const hub = new StatusHub();
  const app = buildApp({
    cfg: testCfg(),
    pool: null,
    redis: null,
    redisPub: null,
    broker,
    engine,
    getEvents: () => events,
    setEvents: () => {},
    hub,
    brokerName: "MockBroker",
    brokerMode: "mock",
    liveRefused: false,
    stubNote: null,
  });
  return { app, broker, engine };
}

async function listen(app: ReturnType<typeof buildApp>) {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no listen address");
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

describe("GET /api/status wires marketSession next to clock", () => {
  it("includes top-level marketSession without changing GateMode", async () => {
    const { app } = makeTestApp();
    const srv = await listen(app);
    try {
      const res = await fetch(`${srv.url}/api/status`);
      expect(res.ok).toBe(true);
      const snap = (await res.json()) as StatusSnapshot;
      expect(snap.clock).toBeTruthy();
      expect(snap.clock.mode).toMatch(/^(idle|PRE-ARM|NO-STOP BAND|SESSION FLATTEN)$/);
      expect(snap.marketSession).toBeTruthy();
      expect(typeof snap.marketSession.cashOpen).toBe("boolean");
      expect(typeof snap.marketSession.asOfEt).toBe("string");
      expect(["weekend", "holiday", "early_close", null]).toContain(
        snap.marketSession.closedReason,
      );
      expect(Object.prototype.hasOwnProperty.call(snap, "marketSession")).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(snap.clock, "marketSession")).toBe(false);

      const expected = computeMarketSession(new Date());
      expect(snap.marketSession.cashOpen).toBe(expected.cashOpen);
      expect(snap.marketSession.closedReason).toBe(expected.closedReason);
      expect(snap.marketSession.holidayName).toBe(expected.holidayName);
    } finally {
      await srv.close();
    }
  });
});
