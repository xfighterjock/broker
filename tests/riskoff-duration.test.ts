import { describe, expect, it } from "vitest";
import type { Position } from "../shared/types";
import { defaultSleeves } from "../shared/types";
import {
  runAutopilot,
  type AutoBuy,
  type AutoSell,
} from "../server/src/autopilot";
import {
  decideRiskoffDuration,
  openRiskoffDurationPositions,
  overlayHoldsDurationName,
  riskoffDurationAllowed,
} from "../server/src/riskoffDuration";
import {
  emptyRiskoffEtfReturns,
  sizeRiskoffEtfShares,
  type RiskoffEtfReturns,
} from "../server/src/riskoffEtf";
import {
  DEFAULT_SLEEVE_EQUITY_USD,
  RISKOFF_DURATION_NOTIONAL_FRAC,
  RISKOFF_DURATION_STOP_MUL,
  RISKOFF_ETF_NOTIONAL_FRAC,
  RISKOFF_ETF_STOP_MUL,
  RISKOFF_ETF_SYMBOLS,
  type RiskoffEtfSymbol,
} from "../shared/constants";

function etfPos(symbol: string, qty: number, avg = 100, gatedDuration = false): Position {
  return {
    id: gatedDuration ? `dur-${symbol}` : `etf-${symbol}`,
    symbol,
    root: null,
    qty,
    side: "Long",
    avgPrice: avg,
    unrealizedPnl: 0,
    gated: false,
    sleeveId: "riskoff",
    ...(gatedDuration ? { gatedDuration: true } : {}),
  };
}

function etfQuotes(lasts: Record<string, number>) {
  return Object.entries(lasts).map(([symbol, last]) => ({ symbol, last }));
}

function etfRs(overrides: Partial<Record<RiskoffEtfSymbol, number | null>>): RiskoffEtfReturns {
  const out = emptyRiskoffEtfReturns();
  for (const s of RISKOFF_ETF_SYMBOLS) out[s] = 0;
  out.BIL = 0.01;
  for (const [k, v] of Object.entries(overrides) as Array<[RiskoffEtfSymbol, number | null]>) {
    out[k] = v;
  }
  return out;
}

const gldWins = etfRs({ GLD: 0.12, UUP: 0.04 });
const tltWins = etfRs({ TLT: 0.14, GLD: 0.05, UUP: 0.04 });
const allEtfQuotes = etfQuotes({
  GLD: 180,
  UUP: 28,
  TLT: 90,
  IEF: 95,
  XLU: 70,
  XLP: 80,
  DBMF: 28,
  BIL: 91,
});

function paperBook(initial: Position[] = []) {
  let positions = initial.map((p) => ({ ...p }));
  return {
    getPositions: () => positions,
    place: async (b: AutoBuy) => {
      positions = [
        ...positions.filter(
          (p) => !(p.sleeveId === b.sleeveId && p.symbol.toUpperCase() === b.symbol.toUpperCase()),
        ),
        etfPos(b.symbol, b.qty, 100, b.gatedDuration === true),
      ];
      return { ok: true as const };
    },
    close: async (s: AutoSell) => {
      const wantDur = /gated duration/i.test(s.reason) || /overlay already long/i.test(s.reason);
      positions = positions.filter((p) => {
        if (p.sleeveId !== s.sleeveId || p.symbol.toUpperCase() !== s.symbol.toUpperCase()) {
          return true;
        }
        if (wantDur) return p.gatedDuration !== true;
        return p.gatedDuration === true;
      });
      return { ok: true as const };
    },
  };
}

describe("gated TLT/IEF duration", () => {
  it("documents the 20% / 40% split and shares the overlay disaster stop", () => {
    expect(RISKOFF_DURATION_NOTIONAL_FRAC).toBe(0.2);
    expect(DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_DURATION_NOTIONAL_FRAC).toBe(20_000);
    expect(RISKOFF_ETF_NOTIONAL_FRAC).toBe(0.4);
    expect(RISKOFF_DURATION_STOP_MUL).toBe(RISKOFF_ETF_STOP_MUL);
    expect(RISKOFF_DURATION_STOP_MUL).toBe(0.92);
    expect(riskoffDurationAllowed(false, false, false)).toBe(true);
    expect(riskoffDurationAllowed(false, true, false)).toBe(false);
    expect(riskoffDurationAllowed(true, false, false)).toBe(false);
    expect(riskoffDurationAllowed(false, undefined, false)).toBe(false);
    expect(riskoffDurationAllowed(false, false, undefined)).toBe(false);
  });

  it("RISK OFF + SPY below 200 + dollar clear → buy TLT (IEF fallback)", async () => {
    const book = paperBook();
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false, dollarVeto: false },
      riskoffEtfReturns: gldWins,
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    const durationBuys = result.bought.filter((b) => b.gatedDuration);
    const overlayBuys = result.bought.filter((b) => b.sleeveId === "riskoff" && !b.gatedDuration);
    expect(overlayBuys.map((b) => b.symbol)).toEqual(["GLD"]);
    expect(durationBuys).toHaveLength(1);
    expect(durationBuys[0].symbol).toBe("TLT");
    expect(durationBuys[0].thesis).toMatch(/gated duration TLT \(SPY below 200, dollar clear\)/);
    expect(durationBuys[0].qty).toBe(
      sizeRiskoffEtfShares(90, DEFAULT_SLEEVE_EQUITY_USD, RISKOFF_DURATION_NOTIONAL_FRAC),
    );
    expect(durationBuys[0].qty * 90).toBeLessThanOrEqual(
      DEFAULT_SLEEVE_EQUITY_USD * RISKOFF_DURATION_NOTIONAL_FRAC,
    );
    expect(durationBuys[0].stopPrice).toBeCloseTo(90 * RISKOFF_DURATION_STOP_MUL);
    expect(openRiskoffDurationPositions(book.getPositions()).map((p) => p.symbol)).toEqual(["TLT"]);

    const iefOnly = decideRiskoffDuration({
      riskOn: false,
      spyAbove200: false,
      dollarVeto: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      quotes: etfQuotes({ IEF: 95 }),
    });
    expect(iefOnly.buy?.symbol).toBe("IEF");
    expect(iefOnly.buy?.thesis).toMatch(/gated duration IEF/);
  });

  it("HYG-only OFF (SPY above 200) → flat / flatten duration", async () => {
    const decided = decideRiskoffDuration({
      riskOn: false,
      spyAbove200: true,
      dollarVeto: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      quotes: allEtfQuotes,
    });
    expect(decided.buy).toBeNull();

    const book = paperBook([etfPos("TLT", 200, 90, true), etfPos("GLD", 100, 180)]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: true, hygAbove200: false, dollarVeto: false },
      riskoffEtfReturns: gldWins,
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.sold.some((s) => s.symbol === "TLT" && /gated duration/i.test(s.reason))).toBe(true);
    expect(result.sold.some((s) => s.symbol === "GLD")).toBe(false);
    expect(book.getPositions().filter((p) => p.gatedDuration)).toEqual([]);
    expect(book.getPositions().some((p) => p.symbol === "GLD" && !p.gatedDuration)).toBe(true);
    expect(result.bought.filter((b) => b.gatedDuration)).toEqual([]);
  });

  it("dollarVeto true → flat / flatten", async () => {
    expect(
      decideRiskoffDuration({
        riskOn: false,
        spyAbove200: false,
        dollarVeto: true,
        positions: [],
        sleeve: defaultSleeves().riskoff,
        quotes: allEtfQuotes,
      }).buy,
    ).toBeNull();

    const book = paperBook([etfPos("TLT", 200, 90, true)]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false, dollarVeto: true },
      riskoffEtfReturns: gldWins,
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.sold.map((s) => s.symbol)).toContain("TLT");
    expect(result.sold.find((s) => s.symbol === "TLT")?.reason).toMatch(/dollar veto/i);
    expect(result.bought.filter((b) => b.gatedDuration)).toEqual([]);
  });

  it("RISK ON → flatten duration and leave overlay flatten to the RS path", async () => {
    const book = paperBook([etfPos("TLT", 200, 90, true), etfPos("GLD", 100, 180)]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: true,
      riskChecks: { spyAbove200: true, dollarVeto: false },
      riskoffEtfReturns: gldWins,
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.sold.some((s) => s.symbol === "TLT" && /risk on: flatten gated duration/i.test(s.reason))).toBe(
      true,
    );
    expect(result.sold.some((s) => s.symbol === "GLD" && /flatten risk-off ETF/i.test(s.reason))).toBe(true);
    expect(result.bought.filter((b) => b.sleeveId === "riskoff")).toEqual([]);
    expect(book.getPositions()).toEqual([]);
  });

  it("missing spyAbove200 → no new buy", () => {
    const decided = decideRiskoffDuration({
      riskOn: false,
      dollarVeto: false,
      positions: [],
      sleeve: defaultSleeves().riskoff,
      quotes: allEtfQuotes,
    });
    expect(decided.buy).toBeNull();
    expect(decided.reason).toMatch(/missing spyAbove200/);
  });

  it("overlay already in TLT → no second duration buy", async () => {
    expect(overlayHoldsDurationName([etfPos("TLT", 400, 90)])).toBe(true);
    expect(overlayHoldsDurationName([etfPos("GLD", 100, 180)])).toBe(false);

    const book = paperBook([etfPos("TLT", 400, 90)]);
    const result = await runAutopilot({
      enabled: true,
      getPositions: book.getPositions,
      getSleeves: () => defaultSleeves(),
      momentumRows: [],
      featureRows: [],
      scanReady: true,
      riskOn: false,
      riskChecks: { spyAbove200: false, dollarVeto: false },
      riskoffEtfReturns: tltWins,
      riskoffEtfQuotes: allEtfQuotes,
      place: book.place,
      close: book.close,
      log: () => {},
    });
    expect(result.bought.filter((b) => b.gatedDuration)).toEqual([]);
    expect(book.getPositions().filter((p) => p.symbol === "TLT")).toHaveLength(1);
    expect(book.getPositions().filter((p) => p.gatedDuration)).toHaveLength(0);
  });
});
