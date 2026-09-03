import { afterEach, describe, expect, it, vi } from "vitest";
import { zonedTimeToUtc } from "../shared/clock";
import { DEFAULT_SLEEVE_EQUITY_USD } from "../shared/constants";
import {
  defaultAutoPaperBySleeve,
  defaultSleeves,
  type Position,
  type ScanRow,
  type SleeveCard,
} from "../shared/types";
import {
  decideBuys,
  decideSells,
  isOwnershipArtifact,
  runAutopilot,
  sizeByStopRisk,
  type AutoBuy,
} from "../server/src/autopilot";
import { sleeveBook } from "../server/src/paper";
import { setPaperNow } from "../server/src/vertical";
import type { MinuteBar } from "../server/src/dayMomentum";

afterEach(() => {
  setPaperNow(null);
});

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

  it("ownership opens only when the momentum pullback-after-strength gate fires", () => {
    const pullback = row({
      symbol: "DELL",
      last: 120,
      dist20: 0.01,
      pctFrom52: -0.02,
      above200: true,
    });
    const extended = row({
      symbol: "JPM",
      sector: "Financials",
      last: 210,
      dist20: 0.12,
      pctFrom52: 0,
      ret12m: 0.4,
      above200: true,
    });
    const deep = row({
      symbol: "XOM",
      sector: "Energy",
      last: 80,
      dist20: -0.08,
      pctFrom52: -0.05,
      ret12m: 0.2,
      above200: true,
    });
    expect(decideBuys([extended, deep], [], sleeve("ownership"))).toEqual([]);
    expect(decideBuys([extended, deep], [], sleeve("momentum"))).toEqual([]);
    const owns = decideBuys([pullback, extended], [], sleeve("ownership"));
    expect(owns.map((b) => b.symbol)).toEqual(["DELL"]);
    expect(owns[0].sleeveId).toBe("ownership");
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

  it("never auto-buys the day sleeve (or options / riskoff stock)", () => {
    const rows = [row({ symbol: "DELL" }), row({ symbol: "MES" })];
    expect(decideBuys(rows, [], sleeve("day"))).toEqual([]);
    expect(decideBuys(rows, [], sleeve("options"))).toEqual([]);
    expect(decideBuys(rows, [], sleeve("riskoff"))).toEqual([]);
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

  it("does not apply momentum setup-gone exits to ownership", () => {
    const sells = decideSells(
      [pos("JPM", "ownership"), pos("EXPE", "momentum")],
      [row({ symbol: "DELL" })],
      [
        { symbol: "JPM", above200: true },
        { symbol: "EXPE", above200: true },
      ],
      sleeves,
    );
    expect(sells).toEqual([{ sleeveId: "momentum", symbol: "EXPE", reason: "setup gone" }]);
  });

  it("still sells ownership on independent thesis-broken (below 200dma) or loss cap", () => {
    const below = decideSells(
      [pos("JPM", "ownership")],
      [row({ symbol: "JPM" })],
      [{ symbol: "JPM", above200: false }],
      sleeves,
    );
    expect(below).toEqual([{ sleeveId: "ownership", symbol: "JPM", reason: "below 200dma" }]);
    const capped = defaultSleeves();
    capped.ownership.paper.realizedPnlUsd = -capped.ownership.lossCapUsd;
    const capSells = decideSells(
      [pos("JPM", "ownership")],
      [row({ symbol: "JPM" })],
      [{ symbol: "JPM", above200: true }],
      capped,
    );
    expect(capSells).toEqual([{ sleeveId: "ownership", symbol: "JPM", reason: "sleeve loss cap" }]);
  });
});

function rthBar(hour: number, minute: number, close: number): MinuteBar {
  const ts = zonedTimeToUtc(2026, 9, 2, hour, minute, 0).getTime();
  return { ts, open: close, high: 100, low: 80, close, volume: 1000 };
}

function mesBuyBars(): MinuteBar[] {
  const out: MinuteBar[] = [];
  for (let i = 0; i < 22; i++) {
    const total = 9 * 60 + 30 + i * 5;
    out.push(rthBar(Math.floor(total / 60), total % 60, 81));
  }
  out[21] = { ...out[21], close: 99, high: 100, low: 80 };
  return out;
}

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
      featureRows: [{ symbol: "DELL", above200: true }],
      scanReady: true,
      riskOn: true,
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
    const book: Position[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => book,
      getSleeves: () => defaultSleeves(),
      momentumRows: [
        row({ symbol: "DELL", last: 120 }),
        row({ symbol: "EXPE", sector: "Consumer Discretionary", last: 140 }),
      ],
      featureRows: [],
      scanReady: true,
      riskOn: true,
      place: async (b) => {
        if (b.symbol === "DELL") return { ok: false, error: "no delayed last" };
        book.push(pos(b.symbol, b.sleeveId));
        placed.push(`${b.sleeveId}:${b.symbol}`);
        return { ok: true };
      },
      close: async () => ({ ok: true }),
      log: () => {},
    });
    expect(placed).toEqual(["momentum:EXPE"]);
    expect(result.bought.map((b) => `${b.sleeveId}:${b.symbol}`)).toEqual(["momentum:EXPE"]);
  });

  it("opens ownership from leftover momentum-gate names, never uptrend-only rows", async () => {
    const book: Position[] = ["A", "B", "C", "D", "E"].map((s) => pos(s, "momentum"));
    const momentumHits = ["A", "B", "C", "D", "E", "JPM"].map((s, i) =>
      row({ symbol: s, sector: `S${i}`, score: 1 - i * 0.01, last: 100 + i }),
    );
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => book,
      getSleeves: () => defaultSleeves(),
      momentumRows: momentumHits,
      featureRows: book.map((p) => ({ symbol: p.symbol, above200: true })),
      scanReady: true,
      riskOn: true,
      place: async (b) => {
        book.push(pos(b.symbol, b.sleeveId));
        return { ok: true };
      },
      close: async () => ({ ok: true }),
      log: () => {},
    });
    expect(result.bought).toHaveLength(1);
    expect(result.bought[0].sleeveId).toBe("ownership");
    expect(result.bought[0].symbol).toBe("JPM");
    expect(result.bought[0].stopPrice).toBeCloseTo(105 * 0.98);
    expect(result.sold).toEqual([]);
  });

  it("risk-off skips new ownership buys but still allows independent ownership exits", async () => {
    const closed: string[] = [];
    const placed: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [pos("JPM", "ownership"), pos("DELL", "ownership")],
      getSleeves: () => defaultSleeves(),
      momentumRows: [row({ symbol: "AAPL" })],
      featureRows: [
        { symbol: "JPM", above200: false },
        { symbol: "DELL", above200: true },
      ],
      scanReady: true,
      riskOn: false,
      place: async (b) => {
        placed.push(`${b.sleeveId}:${b.symbol}`);
        return { ok: true };
      },
      close: async (s) => {
        closed.push(`${s.sleeveId}:${s.symbol}:${s.reason}`);
        return { ok: true };
      },
      log: () => {},
    });
    expect(placed).toEqual([]);
    expect(result.bought).toEqual([]);
    expect(closed).toEqual(["ownership:JPM:below 200dma"]);
    expect(result.sold).toEqual([
      { sleeveId: "ownership", symbol: "JPM", reason: "below 200dma" },
    ]);
  });

  it("never auto-sells puts, calls, or naked shorts (CSP/CC stay manual)", async () => {
    setPaperNow(new Date("2026-08-24T14:00:00Z")); // Mon 10:00 ET
    const verts: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [row({ symbol: "AAPL", last: 67 })],
      featureRows: [],
      scanReady: true,
      riskOn: true,
      place: async () => ({ ok: true }),
      close: async () => ({ ok: true }),
      placeVertical: async (v) => {
        verts.push(`${v.sleeveId}:${v.right}:${v.symbol}`);
        expect(v.right).toBe("C");
        expect(v.sleeveId).toBe("options");
        return { ok: true };
      },
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async () => [
        {
          underlying: "AAPL",
          osiKey: "O:AAPL261009C00065000",
          displaySymbol: "AAPL C 65",
          right: "C",
          strike: 65,
          expiry: "2026-10-09",
          bid: 4.9,
          ask: 5,
          last: 5.15,
          bidSize: 1,
          askSize: 1,
          openInterest: 10,
          delta: 0.5,
          gamma: 0.01,
          theta: -0.02,
          vega: 0.1,
          iv: 0.2,
        },
        {
          underlying: "AAPL",
          osiKey: "O:AAPL261009C00070000",
          displaySymbol: "AAPL C 70",
          right: "C",
          strike: 70,
          expiry: "2026-10-09",
          bid: 2.5,
          ask: 2.6,
          last: 2.45,
          bidSize: 1,
          askSize: 1,
          openInterest: 10,
          delta: 0.3,
          gamma: 0.01,
          theta: -0.02,
          vega: 0.1,
          iv: 0.2,
        },
      ],
      log: () => {},
    });
    expect(verts).toEqual(["options:C:AAPL"]);
    expect(result.verticals.every((v) => v.right === "C" && v.sleeveId === "options")).toBe(true);
    expect(result.bought.every((b) => b.side === "Buy")).toBe(true);
  });

  it("skips day MES while other sleeves still run", async () => {
    const noon = zonedTimeToUtc(2026, 9, 2, 11, 20, 0);
    const placed: string[] = [];
    const sleeveAuto = { ...defaultAutoPaperBySleeve(true), day: false, options: false };
    const result = await runAutopilot({
      enabled: true,
      sleeveAuto,
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [row({ symbol: "DELL", last: 120 })],
      featureRows: [],
      scanReady: true,
      riskOn: true,
      gateMode: "idle",
      now: noon,
      dayBars: mesBuyBars(),
      place: async (b) => {
        placed.push(`${b.sleeveId}:${b.symbol}`);
        return { ok: true };
      },
      close: async () => ({ ok: true }),
      log: () => {},
    });
    expect(placed.some((p) => p.startsWith("day:"))).toBe(false);
    expect(placed).toContain("momentum:DELL");
    expect(result.bought.every((b) => b.sleeveId !== "day")).toBe(true);
  });

  it("skips momentum/ownership longs when those sleeves are off", async () => {
    const placed: string[] = [];
    const result = await runAutopilot({
      enabled: true,
      sleeveAuto: {
        ...defaultAutoPaperBySleeve(false),
        day: false,
        momentum: false,
        ownership: false,
        options: false,
        riskoff: true,
      },
      getPositions: () => [],
      getSleeves: () => defaultSleeves(),
      momentumRows: [row({ symbol: "DELL", last: 120 })],
      featureRows: [{ symbol: "JPM", above200: false }],
      scanReady: true,
      riskOn: true,
      place: async (b) => {
        placed.push(`${b.sleeveId}:${b.symbol}`);
        return { ok: true };
      },
      close: async () => ({ ok: true }),
      log: () => {},
    });
    expect(placed).toEqual([]);
    expect(result.bought).toEqual([]);
    expect(result.sold).toEqual([]);
  });

  it("does not rotate riskoff when that sleeve is off, even if day is on", async () => {
    const noon = zonedTimeToUtc(2026, 9, 2, 11, 20, 0);
    const placed: string[] = [];
    const closed: string[] = [];
    const verts: string[] = [];
    await runAutopilot({
      enabled: true,
      sleeveAuto: { ...defaultAutoPaperBySleeve(false), day: true },
      getPositions: () => [
        {
          id: "gld",
          symbol: "GLD",
          root: null,
          qty: 10,
          side: "Long",
          avgPrice: 180,
          unrealizedPnl: 0,
          gated: false,
          sleeveId: "riskoff",
        },
      ],
      getSleeves: () => defaultSleeves(),
      momentumRows: [row({ symbol: "DELL", last: 120 })],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false, hygAbove200: false },
      riskoffQuotes: [{ symbol: "SPY", last: 500 }],
      riskoffEtfReturns: { GLD: 0.1, UUP: 0.2, BIL: 0.01 },
      riskoffEtfQuotes: [
        { symbol: "GLD", last: 180 },
        { symbol: "UUP", last: 28 },
        { symbol: "BIL", last: 91 },
      ],
      gateMode: "idle",
      now: noon,
      dayBars: mesBuyBars(),
      place: async (b) => {
        placed.push(`${b.sleeveId}:${b.symbol}`);
        return { ok: true };
      },
      close: async (s) => {
        closed.push(`${s.sleeveId}:${s.symbol}`);
        return { ok: true };
      },
      placeVertical: async (v) => {
        verts.push(`${v.sleeveId}:${v.symbol}`);
        return { ok: true };
      },
      fetchExpiries: async () => [
        { year: 2026, month: 10, day: 9, expiry: "2026-10-09", expiryType: "MONTHLY" },
      ],
      fetchChain: async () => [],
      log: () => {},
    });
    expect(placed.every((p) => p.startsWith("day:"))).toBe(true);
    expect(closed.some((c) => c.startsWith("riskoff:"))).toBe(false);
    expect(verts).toEqual([]);
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

  it("day/options/riskoff stay at $0 P/L with no fills", () => {
    const day = sleeveBook(sleeve("day"), [], []);
    const opt = sleeveBook(sleeve("options"), [], []);
    const off = sleeveBook(sleeve("riskoff"), [], []);
    expect(day.pnlUsd).toBe(0);
    expect(day.equityUsd).toBe(100_000);
    expect(opt.pnlUsd).toBe(0);
    expect(opt.equityUsd).toBe(100_000);
    expect(off.pnlUsd).toBe(0);
    expect(off.equityUsd).toBe(100_000);
  });

  it("sizes qty so 1.5% stop risks ~1% of $100k (min 1)", () => {
    const qty = sizeByStopRisk(100, 98.5, "DELL", 100_000);
    expect(qty).toBe(Math.floor(1000 / 1.5));
    expect(qty).toBe(666);
    expect(sizeByStopRisk(100, 100, "DELL", 100_000)).toBe(1);
  });
});
