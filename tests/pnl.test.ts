import { describe, expect, it } from "vitest";
import { DEFAULT_SLEEVE_EQUITY_USD } from "../shared/constants";
import { defaultSleeves, type Position } from "../shared/types";
import { overlayDayPnl } from "../server/src/overlay";
import {
  applySessionPnl,
  computeSleevePnl,
  nySessionDate,
  openLotDayPnl,
  openSessionMark,
  sleeveBook,
} from "../server/src/paper";
import { verticalDayPnl } from "../server/src/vertical";

describe("sleeve daily + total P/L", () => {
  it("totalPnl is equity minus 100k starting book", () => {
    const { totalPnlUsd } = computeSleevePnl({
      equityUsd: 100_250,
      realizedPnlUsd: 200,
      unrealizedPnlUsd: 50,
      sessionMark: null,
      todayRealizedPnlUsd: 0,
    });
    expect(totalPnlUsd).toBe(250);
    expect(totalPnlUsd).toBe(100_250 - DEFAULT_SLEEVE_EQUITY_USD);
  });

  it("with no prior snapshot, daily is today's realized + uPnL from 0", () => {
    const { dailyPnlUsd } = computeSleevePnl({
      equityUsd: 100_150,
      realizedPnlUsd: 1_000,
      unrealizedPnlUsd: 40,
      sessionMark: null,
      todayRealizedPnlUsd: 110,
    });
    expect(dailyPnlUsd).toBe(150);
  });

  it("with a session mark, daily is Δrealized + Δunrealized", () => {
    const { dailyPnlUsd, totalPnlUsd } = computeSleevePnl({
      equityUsd: 100_400,
      realizedPnlUsd: 300,
      unrealizedPnlUsd: 100,
      sessionMark: {
        sessionDate: "2026-08-27",
        realizedPnlUsd: 200,
        unrealizedPnlUsd: 50,
      },
    });
    expect(dailyPnlUsd).toBe(150);
    expect(totalPnlUsd).toBe(400);
  });

  it("openSessionMark: first snapshot marks realized now and uPnL from 0", () => {
    const mark = openSessionMark("2026-08-27", 80, 25, null);
    expect(mark).toEqual({
      sessionDate: "2026-08-27",
      realizedPnlUsd: 80,
      unrealizedPnlUsd: 0,
    });
    const book = applySessionPnl(
      {
        equityUsd: 100_105,
        realizedPnlUsd: 80,
        unrealizedPnlUsd: 25,
        pnlUsd: 105,
        totalPnlUsd: 105,
        dailyPnlUsd: 0,
      },
      mark,
    );
    expect(book.dailyPnlUsd).toBe(25);
    expect(book.totalPnlUsd).toBe(105);
  });

  it("openSessionMark keeps the same-day mark and rolls a new NY session vs start-of-day book", () => {
    const prior = openSessionMark("2026-08-26", 10, 5, null);
    const same = openSessionMark("2026-08-26", 99, 99, prior);
    expect(same).toBe(prior);
    const next = openSessionMark("2026-08-27", 40, 12, prior);
    expect(next).toEqual({
      sessionDate: "2026-08-27",
      realizedPnlUsd: 40,
      unrealizedPnlUsd: 12,
    });
  });

  it("sleeveBook total matches equity - 100k including open uPnL", () => {
    const sleeves = defaultSleeves();
    sleeves.momentum.paper.realizedPnlUsd = 20;
    const positions: Position[] = [
      {
        id: "p1",
        symbol: "SPY",
        root: null,
        qty: 2,
        side: "Long",
        avgPrice: 100,
        unrealizedPnl: 8,
        gated: false,
        sleeveId: "momentum",
      },
    ];
    const book = sleeveBook(sleeves.momentum, positions);
    expect(book.realizedPnlUsd).toBe(20);
    expect(book.unrealizedPnlUsd).toBe(8);
    expect(book.equityUsd).toBe(100_028);
    expect(book.totalPnlUsd).toBe(28);
    expect(book.pnlUsd).toBe(28);
  });

  it("nySessionDate is YYYY-MM-DD", () => {
    expect(nySessionDate(new Date("2026-08-27T22:00:00.000Z"))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("open-lot day P/L", () => {
  it("uses signedPnl vs prior close, including futures point value and short sign", () => {
    expect(
      openLotDayPnl(
        { side: "Long", qty: 3, symbol: "SPY" },
        { last: 102, prevClose: 100, change: 5 },
      ),
    ).toBe(6);
    expect(
      openLotDayPnl(
        { side: "Short", qty: 1, symbol: "MES=F" },
        { last: 5802, prevClose: 5800, change: 2 },
      ),
    ).toBe(-10);
  });

  it("falls back to the quote day change only when prior close is missing", () => {
    expect(
      openLotDayPnl(
        { side: "Long", qty: 2, symbol: "QQQ" },
        { last: 400, prevClose: null, change: 1.5 },
      ),
    ).toBe(3);
    expect(
      openLotDayPnl(
        { side: "Short", qty: 1, symbol: "MES=F" },
        { last: null, prevClose: null, change: 2 },
      ),
    ).toBe(-10);
  });

  it("does not invent a day P/L for a flat lot or a quote with no day move", () => {
    expect(
      openLotDayPnl(
        { side: "Flat", qty: 0, symbol: "SPY" },
        { last: 102, prevClose: 100, change: 2 },
      ),
    ).toBeNull();
    expect(
      openLotDayPnl(
        { side: "Long", qty: 1, symbol: "SPY" },
        { last: 102, prevClose: null, change: null },
      ),
    ).toBeNull();
    expect(openLotDayPnl({ side: "Long", qty: 1, symbol: "SPY" }, null)).toBeNull();
  });

  it("dollarizes option netChange with the 100 multiplier", () => {
    expect(verticalDayPnl({ qty: 2, long: { netChange: 0.1 }, short: { netChange: -0.05 } })).toBeCloseTo(30);
    expect(verticalDayPnl({ qty: 1, long: { netChange: 0.1 }, short: {} })).toBeNull();
    expect(overlayDayPnl({ qty: 1, leg: { netChange: 0.1 } })).toBe(-10);
    expect(overlayDayPnl({ qty: 1, leg: {} })).toBeNull();
  });
});
