import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SLEEVE_EQUITY_USD } from "../shared/constants";
import { defaultSleeves, type Position, type ScanRow, type SleeveCard } from "../shared/types";
import {
  decideBuys,
  decideSells,
  isOwnershipArtifact,
  runAutopilot,
  sizeByStopRisk,
  type AutoBuy,
} from "../server/src/autopilot";
import { sleeveBook } from "../server/src/paper";

function row(partial: Partial<ScanRow> & Pick<ScanRow, "symbol">): ScanRow {
  return {
    name: partial.symbol,
    sector: "Information Technology",
    last: 100,
    pctFrom52: -0.02,
    dist20: 0.01,
    above200: true,
    ret3m: 0.1,
    ret6m: 0.2,
    ret12m: 0.3,
    rs3m: 0.05,
    volx: 1,
    score: 0.22,
    why: "above 200 · pullback 20dma",
    ...partial,
  };
}

function pos(
  symbol: string,
  sleeveId: Position["sleeveId"],
  extra: Partial<Position> = {},
): Position {
  return {
    id: `pos-${symbol}`,
    symbol,
    root: null,
    qty: 1,
    side: "Long",
    avgPrice: 100,
    unrealizedPnl: 0,
    gated: false,
    sleeveId,
    ...extra,
  };
}

function sleeve(id: SleeveCard["id"], extra: Partial<SleeveCard> = {}): SleeveCard {
  return { ...defaultSleeves()[id], ...extra };
}

describe("ownership artifact skip", () => {
  it("skips SNDK-like names (huge 12m + last>800 or broken 3m/52w)", () => {
    const sndk = row({
      symbol: "SNDK",
      last: 1200,
      ret12m: 2.4,
      ret3m: -0.15,
      pctFrom52: -0.35,
    });
    expect(isOwnershipArtifact(sndk)).toBe(true);
    const mu = row({ symbol: "MU", last: 150, ret12m: 6.2, ret3m: 0.4, pctFrom52: 0 });
    expect(isOwnershipArtifact(mu)).toBe(true);
    const ok = row({ symbol: "JPM", last: 200, ret12m: 0.4, ret3m: 0.1, pctFrom52: -0.05 });
    expect(isOwnershipArtifact(ok)).toBe(false);
  });

  it("decideBuys ownership drops artifacts and keeps a normal name", () => {
    const buys = decideBuys(
      [
        row({ symbol: "SNDK", last: 900, ret12m: 1.8, ret3m: -0.2, pctFrom52: -0.25 }),
        row({ symbol: "MU", last: 140, ret12m: 5.5 }),
        row({ symbol: "JPM", sector: "Financials", last: 210, ret12m: 0.35 }),
      ],
      [],
      sleeve("ownership"),
    );
    expect(buys.map((b) => b.symbol)).toEqual(["JPM"]);
    expect(buys[0].sleeveId).toBe("ownership");
    expect(buys[0].stopPrice).toBeCloseTo(210 * 0.98);
  });
});

describe("decideBuys caps and skips", () => {
  it("caps momentum at 5 open names", () => {
    const rows = ["A", "B", "C", "D", "E", "F"].map((s, i) =>
      row({ symbol: s, sector: `S${i}`, score: 1 - i * 0.01 }),
    );
    const buys = decideBuys(rows, [], sleeve("momentum"));
    expect(buys).toHaveLength(5);
    expect(buys.map((b) => b.symbol)).toEqual(["A", "B", "C", "D", "E"]);
    expect(buys.every((b) => b.qty >= 1 && b.side === "Buy")).toBe(true);
    expect(buys[0].stopPrice).toBeCloseTo(100 * 0.985);
    expect(buys[0].thesis).toMatch(/score 1\.000/);
    expect(buys[0].thesis).toMatch(/S0/);
  });

  it("does not duplicate a symbol already open in any sleeve (SPY stays)", () => {
    const buys = decideBuys(
      [row({ symbol: "SPY", last: 500 }), row({ symbol: "MSFT", last: 400 })],
      [pos("SPY", "ownership")],
      sleeve("ownership"),
    );
    expect(buys.map((b) => b.symbol)).toEqual(["MSFT"]);
    expect(buys.some((b) => b.symbol === "SPY")).toBe(false);
  });

  it("never auto-buys the day sleeve (or options)", () => {
    const rows = [row({ symbol: "DELL" }), row({ symbol: "MES" })];
    expect(decideBuys(rows, [], sleeve("day"))).toEqual([]);
    expect(decideBuys(rows, [], sleeve("options"))).toEqual([]);
  });

  it("skips new buys when sleeve realized P&L is at the loss cap", () => {
    const s = sleeve("momentum", {
      lossCapUsd: 1000,
      paper: { trades: 3, wins: 0, losses: 3, realizedPnlUsd: -1000, notes: "" },
    });
    expect(decideBuys([row({ symbol: "DELL" })], [], s)).toEqual([]);
  });
});

describe("decideSells kill rules", () => {
  const sleeves = defaultSleeves();

  it("sells a long when the latest feature row is below the 200dma", () => {
    const sells = decideSells(
      [pos("DELL", "momentum")],
      [row({ symbol: "DELL" })],
      [{ symbol: "DELL", above200: false }],
      sleeves,
    );
    expect(sells).toEqual([{ sleeveId: "momentum", symbol: "DELL", reason: "below 200dma" }]);
  });

  it("sells momentum when the name dropped off the current scan (setup gone)", () => {
    const sells = decideSells(
      [pos("EXPE", "momentum"), pos("DELL", "momentum")],
      [row({ symbol: "DELL" })],
      [
        { symbol: "EXPE", above200: true },
        { symbol: "DELL", above200: true },
      ],
      sleeves,
    );
    expect(sells).toEqual([{ sleeveId: "momentum", symbol: "EXPE", reason: "setup gone" }]);
  });

  it("does not sell an extended name that is still a scan hit", () => {
    const sells = decideSells(
      [pos("TECH", "momentum")],
      [row({ symbol: "TECH", dist20: 0.08 })],
      [{ symbol: "TECH", above200: true }],
      sleeves,
    );
    expect(sells).toEqual([]);
  });

  it("does not treat an empty scan as setup-gone when cache is not ready", () => {
    const sells = decideSells(
      [pos("DELL", "momentum")],
      [],
      [],
      sleeves,
      false,
    );
    expect(sells).toEqual([]);
  });

  it("does not auto-sell day sleeve names", () => {
    const sells = decideSells(
      [pos("MES", "day")],
      [],
      [{ symbol: "MES", above200: false }],
      sleeves,
    );
    expect(sells).toEqual([]);
  });
});

describe("runAutopilot toggle", () => {
  it("places nothing when auto paper is off", async () => {
    const place = vi.fn(async (_b: AutoBuy) => ({ ok: true as const }));
    const close = vi.fn(async () => ({ ok: true as const }));
    const log = vi.fn();
    const result = await runAutopilot({
      enabled: false,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [row({ symbol: "DELL" })],
      ownershipRows: [row({ symbol: "JPM" })],
      featureRows: [{ symbol: "DELL", above200: true }],
      scanReady: true,
      place,
      close,
      log,
    });
    expect(result.bought).toEqual([]);
    expect(result.sold).toEqual([]);
    expect(place).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("skips a buy with no last and continues the rest", async () => {
    const placed: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [
        row({ symbol: "DELL", last: 120 }),
        row({ symbol: "EXPE", sector: "Consumer Discretionary", last: 140 }),
      ],
      ownershipRows: [],
      featureRows: [],
      scanReady: true,
      place: async (b) => {
        if (b.symbol === "DELL") return { ok: false, error: "no delayed last" };
        placed.push(b.symbol);
        return { ok: true };
      },
      close: async () => ({ ok: true }),
      log: () => {},
    });
    expect(placed).toEqual(["EXPE"]);
    expect(result.bought.map((b) => b.symbol)).toEqual(["EXPE"]);
  });
});

describe("sleeve equity math ($100k mock books)", () => {
  it("equity is 100000 + realized + unrealized from delayed last via signedPnl", () => {
    const s = sleeve("momentum", {
      paper: { trades: 1, wins: 1, losses: 0, realizedPnlUsd: 50, notes: "" },
    });
    const book = sleeveBook(
      s,
      [pos("DELL", "momentum", { avgPrice: 100, qty: 2 })],
      [
        {
          symbol: "DELL",
          last: 110,
          prevClose: 100,
          change: 10,
          changePct: 0.1,
          asOf: null,
          exchange: "NYSE",
          delayed: true,
          source: "yahoo",
        },
      ],
    );
    expect(DEFAULT_SLEEVE_EQUITY_USD).toBe(100_000);
    expect(book.realizedPnlUsd).toBe(50);
    expect(book.unrealizedPnlUsd).toBe(20);
    expect(book.pnlUsd).toBe(70);
    expect(book.equityUsd).toBe(100_070);
  });

  it("day/options stay at $0 P/L with no fills", () => {
    const day = sleeveBook(sleeve("day"), [], []);
    const opt = sleeveBook(sleeve("options"), [], []);
    expect(day.pnlUsd).toBe(0);
    expect(day.equityUsd).toBe(100_000);
    expect(opt.pnlUsd).toBe(0);
    expect(opt.equityUsd).toBe(100_000);
  });

  it("sizes qty so 1.5% stop risks ~1% of $100k (min 1)", () => {
    const qty = sizeByStopRisk(100, 98.5, "DELL", 100_000);
    expect(qty).toBe(Math.floor(1000 / 1.5));
    expect(qty).toBe(666);
    expect(sizeByStopRisk(100, 100, "DELL", 100_000)).toBe(1);
  });
});
