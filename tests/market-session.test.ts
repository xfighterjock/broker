import http from "node:http";
import { describe, expect, it } from "vitest";
import { seedEvents, zonedTimeToUtc } from "../shared/clock";
import {
  cashCountdownLabel,
  cashCountdownTarget,
  cashSessionCloseMinute,
  computeMarketSession,
  easterSunday,
  formatCashCountdown,
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

describe("cash session open and close instants", () => {
  it("counts to today's 09:30 before the open and to 16:00 once the session is open", () => {
    const pre = atEt(2026, 9, 8, 8, 15);
    expect(pre.cashOpen).toBe(true);
    expect(pre.inCashSession).toBe(false);
    expect(pre.nextOpenEt).toMatch(/2026-09-08 09:30/);
    expect(pre.nextCloseEt).toMatch(/2026-09-08 16:00/);
    expect(pre.nextOpenAt).toBe(zonedTimeToUtc(2026, 9, 8, 9, 30, 0).toISOString());
    expect(pre.nextCloseAt).toBe(zonedTimeToUtc(2026, 9, 8, 16, 0, 0).toISOString());

    const bell = atEt(2026, 9, 8, 9, 30);
    expect(bell.inCashSession).toBe(true);
    expect(bell.nextCloseEt).toMatch(/2026-09-08 16:00/);
    expect(bell.nextOpenEt).toMatch(/2026-09-09 09:30/);

    const mid = atEt(2026, 9, 8, 10, 0);
    expect(mid.inCashSession).toBe(true);
    expect(mid.nextCloseAt).toBe(zonedTimeToUtc(2026, 9, 8, 16, 0, 0).toISOString());
    expect(mid.nextOpenAt).toBe(zonedTimeToUtc(2026, 9, 9, 9, 30, 0).toISOString());

    const closed = atEt(2026, 9, 8, 16, 0);
    expect(closed.inCashSession).toBe(false);
    expect(closed.cashOpen).toBe(true);
    expect(closed.nextOpenEt).toMatch(/2026-09-09 09:30/);
    expect(closed.nextCloseEt).toMatch(/2026-09-09 16:00/);
  });

  it("uses 13:00 ET on early-close days and the next regular open after the close", () => {
    expect(cashSessionCloseMinute(2026, 11, 27)).toBe(13 * 60);
    const during = atEt(2026, 11, 27, 12, 0);
    expect(during.inCashSession).toBe(true);
    expect(during.nextCloseEt).toMatch(/2026-11-27 13:00/);
    expect(during.nextCloseAt).toBe(zonedTimeToUtc(2026, 11, 27, 13, 0, 0).toISOString());

    const after = atEt(2026, 11, 27, 13, 0);
    expect(after.inCashSession).toBe(false);
    expect(after.cashOpen).toBe(true);
    expect(after.closedReason).toBe("early_close");
    expect(after.nextOpenEt).toMatch(/2026-11-30 09:30/);
    expect(after.nextCloseEt).toMatch(/2026-11-30 16:00/);

    const eve = atEt(2026, 12, 24, 8, 0);
    expect(eve.inCashSession).toBe(false);
    expect(eve.nextOpenEt).toMatch(/2026-12-24 09:30/);
    expect(eve.nextCloseEt).toMatch(/2026-12-24 13:00/);
  });

  it("skips holidays and weekends for the next open and that day's close", () => {
    const labor = atEt(2026, 9, 7, 10, 0);
    expect(labor.inCashSession).toBe(false);
    expect(labor.nextOpenAt).toBe(zonedTimeToUtc(2026, 9, 8, 9, 30, 0).toISOString());
    expect(labor.nextCloseAt).toBe(zonedTimeToUtc(2026, 9, 8, 16, 0, 0).toISOString());

    const sat = atEt(2026, 9, 5, 12, 0);
    expect(sat.inCashSession).toBe(false);
    expect(sat.nextOpenEt).toMatch(/2026-09-08 09:30/);
    expect(cashSessionCloseMinute(2026, 9, 7)).toBeNull();
  });
});

describe("cash countdown formatter and target", () => {
  it("drops zero higher units and keeps seconds", () => {
    expect(formatCashCountdown(2 * 3600_000 + 14 * 60_000 + 3_000)).toBe("2h 14m 03s");
    expect(formatCashCountdown(14 * 60_000 + 3_000)).toBe("14m 03s");
    expect(formatCashCountdown(3_000)).toBe("03s");
    expect(formatCashCountdown(2 * 3600_000 + 3_000)).toBe("2h 0m 03s");
    expect(formatCashCountdown(0)).toBe("00s");
    expect(formatCashCountdown(-50)).toBe("00s");
    expect(formatCashCountdown(61 * 3600_000 + 60_000)).toBe("61h 1m 00s");
  });

  it("counts to close while the session is open and to open when it is not", () => {
    const mid = computeMarketSession(zonedTimeToUtc(2026, 9, 8, 10, 0, 0));
    const now = zonedTimeToUtc(2026, 9, 8, 10, 0, 0).getTime();
    const closeTarget = cashCountdownTarget(mid, now);
    expect(closeTarget?.kind).toBe("close");
    expect(cashCountdownLabel("close", (closeTarget?.atMs ?? 0) - now)).toBe("Cash close in 6h 0m 00s");

    const pre = computeMarketSession(zonedTimeToUtc(2026, 9, 8, 8, 0, 0));
    const preNow = zonedTimeToUtc(2026, 9, 8, 8, 0, 0).getTime();
    const openTarget = cashCountdownTarget(pre, preNow);
    expect(openTarget?.kind).toBe("open");
    expect(cashCountdownLabel("open", (openTarget?.atMs ?? 0) - preNow)).toBe("Cash open in 1h 30m 00s");

    const holiday = computeMarketSession(zonedTimeToUtc(2026, 9, 7, 10, 0, 0));
    expect(cashCountdownTarget(holiday, zonedTimeToUtc(2026, 9, 7, 10, 0, 0).getTime())?.kind).toBe(
      "open",
    );

    const early = computeMarketSession(zonedTimeToUtc(2026, 11, 27, 12, 30, 0));
    const earlyNow = zonedTimeToUtc(2026, 11, 27, 12, 30, 0).getTime();
    const earlyTarget = cashCountdownTarget(early, earlyNow);
    expect(earlyTarget?.kind).toBe("close");
    expect(cashCountdownLabel("close", (earlyTarget?.atMs ?? 0) - earlyNow)).toBe(
      "Cash close in 30m 00s",
    );
  });

  it("flips a stale snapshot when the open or close instant passes", () => {
    const pre = computeMarketSession(zonedTimeToUtc(2026, 9, 8, 9, 29, 30));
    const opened = zonedTimeToUtc(2026, 9, 8, 9, 30, 1).getTime();
    expect(pre.inCashSession).toBe(false);
    expect(cashCountdownTarget(pre, opened)?.kind).toBe("close");

    const during = computeMarketSession(zonedTimeToUtc(2026, 9, 8, 15, 59, 30));
    const after = zonedTimeToUtc(2026, 9, 8, 16, 0, 1).getTime();
    expect(during.inCashSession).toBe(true);
    expect(cashCountdownTarget(during, after)?.kind).toBe("open");

    const early = computeMarketSession(zonedTimeToUtc(2026, 11, 27, 12, 59, 0));
    const afterEarly = zonedTimeToUtc(2026, 11, 27, 13, 0, 1).getTime();
    expect(cashCountdownTarget(early, afterEarly)?.kind).toBe("open");
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
      expect(snap.marketSession.inCashSession).toBe(expected.inCashSession);
      expect(snap.marketSession.closedReason).toBe(expected.closedReason);
      expect(snap.marketSession.holidayName).toBe(expected.holidayName);
      expect(snap.marketSession.nextOpenAt).toBe(expected.nextOpenAt);
      expect(snap.marketSession.nextCloseAt).toBe(expected.nextCloseAt);
    } finally {
      await srv.close();
    }
  });
});
