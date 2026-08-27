import { describe, expect, it } from "vitest";
import { DEFAULT_SLEEVE_EQUITY_USD } from "../shared/constants";
import { defaultSleeves, type Position } from "../shared/types";
import {
  applySessionPnl,
  computeSleevePnl,
  nySessionDate,
  openSessionMark,
  sleeveBook,
} from "../server/src/paper";

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
