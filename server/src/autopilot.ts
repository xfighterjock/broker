import {
  DEFAULT_SLEEVE_EQUITY_USD,
  MAX_AUTO_RISKOFF_VERTICALS,
  MAX_AUTO_VERTICALS,
  OPTIONS_DTE_EXIT,
  OPTIONS_DTE_TARGET_MAX,
  OPTIONS_DTE_TARGET_MIN,
  RISKOFF_HYG_SYMBOL,
  RISKOFF_SYMBOLS,
} from "../../shared/constants";
import type {
  OptionExpiry,
  OptionLeg,
  Position,
  ScanRow,
  SleeveCard,
  SleeveId,
} from "../../shared/types";
import { pointValueFor } from "./paper";
import {
  decideRiskoffEtf,
  openRiskoffEtfPositions,
  type RiskoffEtfReturns,
} from "./riskoffEtf";
import { passesMomentumFilter } from "./scan";
import {
  daysToExpiry,
  isVerticalPosition,
  valuationNow,
  verticalEntryWindowOpen,
  verticalStopCooling,
} from "./vertical";

export const MAX_AUTO_MOMENTUM = 5;
export const MAX_AUTO_OWNERSHIP = 5;
export const MOMENTUM_STOP_MUL = 0.985;
export const OWNERSHIP_STOP_MUL = 0.98;
export const AUTO_RISK_FRAC = 0.01;

export type AutoBuy = {
  sleeveId: "momentum" | "ownership" | "riskoff";
  symbol: string;
  side: "Buy";
  qty: number;
  stopPrice: number;
  thesis: string;
};

export type AutoSell = {
  sleeveId: SleeveId;
  symbol: string;
  reason: string;
};

export function isOwnershipArtifact(
  row: Pick<ScanRow, "ret12m" | "ret3m" | "pctFrom52" | "last">,
): boolean {
  const r12 = row.ret12m;
  if (r12 === null || !Number.isFinite(r12)) return false;
  if (r12 > 5) return true;
  if (r12 > 1.5) {
    if (row.ret3m !== null && row.ret3m < 0) return true;
    if (row.pctFrom52 < -0.2) return true;
    if (row.last > 800) return true;
  }
  return false;
}

export function sizeByStopRisk(
  last: number,
  stopPrice: number,
  symbol: string,
  equityUsd: number,
  riskFrac = AUTO_RISK_FRAC,
): number {
  if (!(last > 0) || !Number.isFinite(stopPrice)) return 1;
  const dist = Math.abs(last - stopPrice);
  const { value } = pointValueFor(symbol);
  const per = dist * value;
  const riskUsd = Math.max(0, equityUsd) * riskFrac;
  if (!(per > 0) || !(riskUsd > 0)) return 1;
  return Math.max(1, Math.floor(riskUsd / per));
}

function isOpen(p: Position): boolean {
  return p.side !== "Flat" && p.qty > 0;
}

function symKey(s: string): string {
  return s.trim().toUpperCase();
}

export function decideBuys(
  rows: ScanRow[],
  openPositions: Position[],
  sleeve: SleeveCard,
  riskOn = true,
): AutoBuy[] {
  if (!riskOn) return [];
  if (sleeve.id !== "momentum" && sleeve.id !== "ownership") return [];
  if (sleeve.paper.realizedPnlUsd <= -sleeve.lossCapUsd) return [];

  const openAny = new Set(openPositions.filter(isOpen).map((p) => symKey(p.symbol)));
  const sleeveOpen = openPositions.filter((p) => isOpen(p) && p.sleeveId === sleeve.id);
  const max = sleeve.id === "momentum" ? MAX_AUTO_MOMENTUM : MAX_AUTO_OWNERSHIP;
  let slots = max - sleeveOpen.length;
  if (slots <= 0) return [];

  const stopMul = sleeve.id === "momentum" ? MOMENTUM_STOP_MUL : OWNERSHIP_STOP_MUL;
  let unrealized = 0;
  for (const p of sleeveOpen) unrealized += p.unrealizedPnl;
  const equityUsd = DEFAULT_SLEEVE_EQUITY_USD + sleeve.paper.realizedPnlUsd + unrealized;

  const out: AutoBuy[] = [];
  for (const row of rows) {
    if (slots <= 0) break;
    const symbol = row.symbol.trim().toUpperCase();
    if (!symbol) continue;
    if (openAny.has(symbol)) continue;
    if (!(row.last > 0) || !Number.isFinite(row.last)) continue;
    if (!passesMomentumFilter(row)) continue;
    if (sleeve.id === "ownership" && isOwnershipArtifact(row)) continue;

    const stopPrice = row.last * stopMul;
    const qty = sizeByStopRisk(row.last, stopPrice, symbol, equityUsd);
    const score = Number.isFinite(row.score) ? row.score.toFixed(3) : String(row.score);
    const thesis = `auto ${sleeve.id} score ${score} ${row.sector} ${row.why}`;
    out.push({
      sleeveId: sleeve.id,
      symbol,
      side: "Buy",
      qty,
      stopPrice,
      thesis,
    });
    openAny.add(symbol);
    slots -= 1;
  }
  return out;
}

export function decideSells(
  positions: Position[],
  momentumRows: ScanRow[],
  featureRows: Array<{ symbol: string; above200: boolean }>,
  sleeves: Record<SleeveId, SleeveCard>,
  scanReady = true,
): AutoSell[] {
  const momentumSyms = new Set(momentumRows.map((r) => symKey(r.symbol)));
  const feat = new Map<string, { above200: boolean }>();
  for (const f of featureRows) feat.set(symKey(f.symbol), f);

  const covered = new Set(
    positions
      .filter((x) => isOpen(x) && x.overlay?.kind === "covered-call")
      .flatMap((x) => {
        const o = x.overlay!;
        return [o.underlying, o.quoteSymbol, o.thesisSymbol, x.symbol].map((s) => s.toUpperCase());
      }),
  );

  const out: AutoSell[] = [];
  for (const p of positions) {
    if (!isOpen(p) || p.side !== "Long") continue;
    if (p.overlay || p.vertical) continue;
    const sleeveId = p.sleeveId;
    if (sleeveId !== "momentum" && sleeveId !== "ownership") continue;
    if (sleeveId === "ownership" && covered.has(symKey(p.symbol))) continue;
    const sleeve = sleeves[sleeveId];
    if (!sleeve) continue;

    if (sleeve.paper.realizedPnlUsd <= -sleeve.lossCapUsd) {
      out.push({ sleeveId, symbol: p.symbol, reason: "sleeve loss cap" });
      continue;
    }
    const f = feat.get(symKey(p.symbol));
    if (f && !f.above200) {
      out.push({ sleeveId, symbol: p.symbol, reason: "below 200dma" });
      continue;
    }
    if (scanReady && sleeveId === "momentum" && !momentumSyms.has(symKey(p.symbol))) {
      out.push({ sleeveId, symbol: p.symbol, reason: "setup gone" });
      continue;
    }
  }
  return out;
}


export type AutoVerticalIntent = {
  sleeveId: "options" | "riskoff";
  symbol: string;
  last: number;
  thesis: string;
};

export type AutoVertical = {
  sleeveId: "options" | "riskoff";
  symbol: string;
  right: "C" | "P";
  expiry: string;
  longStrike: number;
  shortStrike: number;
  thesis: string;
};

function openVerticalUnderlyers(positions: Position[], sleeveId: SleeveId): Set<string> {
  const s = new Set<string>();
  for (const p of positions) {
    if (!isOpen(p) || !isVerticalPosition(p) || !p.vertical) continue;
    if (p.sleeveId !== sleeveId) continue;
    s.add(p.vertical.underlying.toUpperCase());
    s.add(p.vertical.quoteSymbol.toUpperCase());
  }
  return s;
}

/** Momentum TA names for debit-call autos. Never puts, CSP, or covered calls. */
export function decideCallVerticalIntents(
  rows: ScanRow[],
  openPositions: Position[],
  sleeve: SleeveCard,
  riskOn = true,
): AutoVerticalIntent[] {
  if (!riskOn) return [];
  if (sleeve.id !== "options") return [];
  if (sleeve.paper.realizedPnlUsd <= -sleeve.lossCapUsd) return [];
  const openV = openPositions.filter((p) => isOpen(p) && p.sleeveId === "options" && isVerticalPosition(p));
  let slots = MAX_AUTO_VERTICALS - openV.length;
  if (slots <= 0) return [];
  const taken = openVerticalUnderlyers(openPositions, "options");
  const out: AutoVerticalIntent[] = [];
  for (const row of rows) {
    if (slots <= 0) break;
    const symbol = row.symbol.trim().toUpperCase();
    if (!symbol || symbol.includes("=")) continue;
    if (taken.has(symbol)) continue;
    if (!(row.last > 0) || !Number.isFinite(row.last)) continue;
    const score = Number.isFinite(row.score) ? row.score.toFixed(3) : String(row.score);
    out.push({
      sleeveId: "options",
      symbol,
      last: row.last,
      thesis: `auto call debit score ${score} ${row.sector} ${row.why}`,
    });
    taken.add(symbol);
    slots -= 1;
  }
  return out;
}

export type RiskoffPutChecks = {
  spyAbove200?: boolean | null;
  hygAbove200?: boolean | null;
};

const RISKOFF_EQUITY_PUTS = new Set<string>([...RISKOFF_SYMBOLS, "IWM"]);

function knownBool(v: boolean | null | undefined): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function verticalUnderlyer(p: Position): string {
  if (!p.vertical) return "";
  return (p.vertical.quoteSymbol || p.vertical.underlying || "").trim().toUpperCase();
}

/** True when RISK OFF and SPY is known below 200dma. Missing check fails closed. */
export function riskoffEquityPutsAllowed(
  riskOn: boolean,
  spyAbove200?: boolean | null,
): boolean {
  return riskOn === false && spyAbove200 === false;
}

/** True when RISK OFF and HYG is known below 200dma. Missing check fails closed. */
export function riskoffHygPutAllowed(
  riskOn: boolean,
  hygAbove200?: boolean | null,
): boolean {
  return riskOn === false && hygAbove200 === false;
}

/** Either the equity-index puts or the HYG credit-leg put may fire. */
export function riskoffPutsAllowed(
  riskOn: boolean,
  checks?: RiskoffPutChecks | null,
): boolean {
  return (
    riskoffEquityPutsAllowed(riskOn, knownBool(checks?.spyAbove200)) ||
    riskoffHygPutAllowed(riskOn, knownBool(checks?.hygAbove200))
  );
}

/**
 * Risk-off put debit intents. HYG first when credit is the broken leg;
 * SPY/QQQ/IWM only when SPY is below 200dma. Missing checks fail closed.
 * Never calls. One per name. Cap MAX_AUTO_RISKOFF_VERTICALS.
 */
export function decidePutVerticalIntents(
  quotes: Array<{ symbol: string; last: number }>,
  openPositions: Position[],
  sleeve: SleeveCard,
  riskOn = true,
  checks?: RiskoffPutChecks | null,
): AutoVerticalIntent[] {
  if (sleeve.id !== "riskoff") return [];
  if (sleeve.paper.realizedPnlUsd <= -sleeve.lossCapUsd) return [];
  const spyAbove200 = knownBool(checks?.spyAbove200);
  const hygAbove200 = knownBool(checks?.hygAbove200);
  const wantHyg = riskoffHygPutAllowed(riskOn, hygAbove200);
  const wantEquity = riskoffEquityPutsAllowed(riskOn, spyAbove200);
  if (!wantHyg && !wantEquity) return [];
  const openV = openPositions.filter((p) => isOpen(p) && p.sleeveId === "riskoff" && isVerticalPosition(p));
  let slots = MAX_AUTO_RISKOFF_VERTICALS - openV.length;
  if (slots <= 0) return [];
  const taken = openVerticalUnderlyers(openPositions, "riskoff");
  const bySym = new Map<string, { symbol: string; last: number }>();
  for (const q of quotes) {
    const symbol = q.symbol.trim().toUpperCase();
    if (!symbol || !Number.isFinite(q.last) || !(q.last > 0)) continue;
    bySym.set(symbol, { symbol, last: q.last });
  }
  const order: string[] = [];
  if (wantHyg) order.push(RISKOFF_HYG_SYMBOL);
  if (wantEquity) order.push(...RISKOFF_SYMBOLS, "IWM");
  const out: AutoVerticalIntent[] = [];
  for (const symbol of order) {
    if (slots <= 0) break;
    const q = bySym.get(symbol);
    if (!q) continue;
    if (taken.has(symbol)) continue;
    const thesis =
      symbol === RISKOFF_HYG_SYMBOL
        ? `auto put debit ${symbol} credit-leg`
        : `auto put debit ${symbol} risk-off`;
    out.push({
      sleeveId: "riskoff",
      symbol,
      last: q.last,
      thesis,
    });
    taken.add(symbol);
    slots -= 1;
  }
  return out;
}

/**
 * Flatten equity-index puts when SPY is back above 200dma.
 * Flatten the HYG credit-leg put when HYG is back above 200dma or RISK ON.
 * Leaves the GLD/UUP/BIL ETF long alone. Missing checks do not flatten that name.
 */
export function decideRiskoffPutSells(
  positions: Position[],
  riskOn = false,
  checks?: RiskoffPutChecks | null,
): AutoSell[] {
  const spyAbove200 = knownBool(checks?.spyAbove200);
  const hygAbove200 = knownBool(checks?.hygAbove200);
  const out: AutoSell[] = [];
  for (const p of positions) {
    if (!isOpen(p) || p.sleeveId !== "riskoff") continue;
    if (!isVerticalPosition(p) || !p.vertical) continue;
    if (p.vertical.right !== "P") continue;
    const u = verticalUnderlyer(p);
    if (u === RISKOFF_HYG_SYMBOL) {
      if (riskOn === true) {
        out.push({
          sleeveId: "riskoff",
          symbol: p.symbol,
          reason: "risk on: flatten credit-leg put",
        });
      } else if (hygAbove200 === true) {
        out.push({
          sleeveId: "riskoff",
          symbol: p.symbol,
          reason: "HYG above 200dma: flatten credit-leg put",
        });
      }
      continue;
    }
    if (RISKOFF_EQUITY_PUTS.has(u) && spyAbove200 === true) {
      out.push({
        sleeveId: "riskoff",
        symbol: p.symbol,
        reason: "SPY above 200dma: flatten risk-off puts",
      });
    }
  }
  return out;
}

/** Long higher-strike (ATM) put, short further OTM (lower strike). Skip if <2 put strikes. */
export function pickAtmPutDebit(
  legs: OptionLeg[],
  last: number,
): { long: OptionLeg; short: OptionLeg } | null {
  if (!(last > 0)) return null;
  const puts = legs.filter((l) => l.right === "P").sort((a, b) => a.strike - b.strike);
  if (puts.length < 2) return null;
  let atmIdx = 0;
  let best = Infinity;
  for (let i = 0; i < puts.length; i++) {
    const d = Math.abs(puts[i].strike - last);
    if (d < best) {
      best = d;
      atmIdx = i;
    }
  }
  if (atmIdx === 0) atmIdx = 1;
  const long = puts[atmIdx];
  const short = puts[atmIdx - 1];
  if (!(long.strike > short.strike)) return null;
  return { long, short };
}

/** Long closer ATM, short the next further OTM call. Skip if <2 call strikes. */
export function pickAtmCallDebit(
  legs: OptionLeg[],
  last: number,
): { long: OptionLeg; short: OptionLeg } | null {
  if (!(last > 0)) return null;
  const calls = legs.filter((l) => l.right === "C").sort((a, b) => a.strike - b.strike);
  if (calls.length < 2) return null;
  let atmIdx = 0;
  let best = Infinity;
  for (let i = 0; i < calls.length; i++) {
    const d = Math.abs(calls[i].strike - last);
    if (d < best) {
      best = d;
      atmIdx = i;
    }
  }
  if (atmIdx >= calls.length - 1) atmIdx = calls.length - 2;
  const long = calls[atmIdx];
  const short = calls[atmIdx + 1];
  if (!(short.strike > long.strike)) return null;
  return { long, short };
}

export function pickTargetExpiry(expiries: OptionExpiry[], now = new Date()): OptionExpiry | null {
  const scored: Array<{ e: OptionExpiry; dte: number }> = [];
  for (const e of expiries) {
    const dte = daysToExpiry(e.expiry, now);
    if (!Number.isFinite(dte)) continue;
    if (dte <= OPTIONS_DTE_EXIT) continue;
    if (dte < OPTIONS_DTE_TARGET_MIN || dte > OPTIONS_DTE_TARGET_MAX) continue;
    scored.push({ e, dte });
  }
  if (!scored.length) return null;
  const mid = (OPTIONS_DTE_TARGET_MIN + OPTIONS_DTE_TARGET_MAX) / 2;
  scored.sort((a, b) => Math.abs(a.dte - mid) - Math.abs(b.dte - mid));
  return scored[0].e;
}

export type PlaceResult = { ok: true } | { ok: false; error: string };
export type CloseResult = { ok: true } | { ok: false; error: string };

export type AutopilotCtx = {
  enabled: boolean;
  getPositions: () => Position[];
  getSleeves: () => Record<SleeveId, SleeveCard>;
  /** Ranked pullback-after-strength scan. Momentum and ownership entries share this gate. */
  momentumRows: ScanRow[];
  featureRows: Array<{ symbol: string; above200: boolean }>;
  scanReady: boolean;
  riskOn: boolean;
  /** From ensureRisk(). Missing spyAbove200 / hygAbove200 fail closed for that name's puts. */
  riskChecks?: RiskoffPutChecks | null;
  place: (buy: AutoBuy) => Promise<PlaceResult>;
  close: (sell: AutoSell) => Promise<CloseResult>;
  /** Paper debit verticals. Call on options when RISK ON; risk-off puts: equity-index if SPY below 200, HYG credit-leg if HYG below 200. Never CSP/CC. */
  placeVertical?: (v: AutoVertical) => Promise<PlaceResult>;
  fetchExpiries?: (symbol: string) => Promise<OptionExpiry[]>;
  fetchChain?: (symbol: string, expiry: string) => Promise<OptionLeg[]>;
  /** Delayed lasts for SPY/QQQ (IWM optional) and HYG, used for risk-off put intents. */
  riskoffQuotes?: Array<{ symbol: string; last: number }>;
  /** 63d total returns for GLD/UUP/BIL. Missing/null → ETF expression fails closed to cash. */
  riskoffEtfReturns?: RiskoffEtfReturns | null;
  /** Delayed lasts used to size/rotate the risk-off ETF long. */
  riskoffEtfQuotes?: Array<{ symbol: string; last: number }>;
  /** Underlying -> ET ymd of last 50% debit stop. Same-day skip. */
  verticalStopCooldown?: Record<string, string>;
  log: (line: string) => void;
};

export async function runAutopilot(ctx: AutopilotCtx): Promise<{
  bought: AutoBuy[];
  sold: AutoSell[];
  verticals: AutoVertical[];
}> {
  const bought: AutoBuy[] = [];
  const sold: AutoSell[] = [];
  const verticals: AutoVertical[] = [];
  if (!ctx.enabled) return { bought, sold, verticals };

  const riskOn = ctx.riskOn === true;
  const spyAbove200 = knownBool(ctx.riskChecks?.spyAbove200);
  const hygAbove200 = knownBool(ctx.riskChecks?.hygAbove200);
  const putChecks: RiskoffPutChecks = { spyAbove200, hygAbove200 };

  const sells = decideSells(
    ctx.getPositions(),
    ctx.momentumRows,
    ctx.featureRows,
    ctx.getSleeves(),
    ctx.scanReady,
  );
  for (const s of sells) {
    const r = await ctx.close(s);
    if (r.ok) {
      ctx.log(
        `auto paper close ${s.sleeveId} ${s.symbol} ${s.reason} (MockBroker, not Tradovate, not live)`,
      );
      sold.push(s);
    } else {
      ctx.log(`auto paper close skip ${s.symbol}: ${r.error}`);
    }
  }

  const etf = decideRiskoffEtf({
    riskOn,
    positions: ctx.getPositions(),
    sleeve: ctx.getSleeves().riskoff,
    returns: ctx.riskoffEtfReturns ?? null,
    quotes: ctx.riskoffEtfQuotes ?? [],
  });
  for (const s of etf.sells) {
    const r = await ctx.close(s);
    if (r.ok) {
      ctx.log(
        `auto paper close ${s.sleeveId} ${s.symbol} ${s.reason} (MockBroker, not Tradovate, not live)`,
      );
      sold.push(s);
    } else {
      ctx.log(`auto paper close skip ${s.symbol}: ${r.error}`);
    }
  }

  const putSells = decideRiskoffPutSells(ctx.getPositions(), riskOn, putChecks);
  for (const s of putSells) {
    const r = await ctx.close(s);
    if (r.ok) {
      ctx.log(
        `auto paper close ${s.sleeveId} ${s.symbol} ${s.reason} (MockBroker, not Tradovate, not live)`,
      );
      sold.push(s);
    } else {
      ctx.log(`auto paper close skip ${s.symbol}: ${r.error}`);
    }
  }

  if (!ctx.scanReady) {
    await placeRiskoffEtfBuy(ctx, etf.buy, bought);
    return { bought, sold, verticals };
  }

  for (const sleeveId of ["momentum", "ownership"] as const) {
    const buys = decideBuys(
      ctx.momentumRows,
      ctx.getPositions(),
      ctx.getSleeves()[sleeveId],
      riskOn,
    );
    for (const b of buys) {
      const r = await ctx.place(b);
      if (r.ok) {
        ctx.log(
          `auto paper buy ${b.sleeveId} ${b.qty} ${b.symbol} stop ${b.stopPrice} ${b.thesis} (MockBroker, not Tradovate, not live)`,
        );
        bought.push(b);
      } else if (/no delayed last/i.test(r.error)) {
        ctx.log(`auto paper skip ${b.symbol} no delayed last`);
      } else {
        ctx.log(`auto paper skip ${b.symbol}: ${r.error}`);
      }
    }
  }
  if (
    riskOn &&
    ctx.placeVertical &&
    ctx.fetchExpiries &&
    ctx.fetchChain
  ) {
    const intents = decideCallVerticalIntents(
      ctx.momentumRows,
      ctx.getPositions(),
      ctx.getSleeves().options,
      riskOn,
    );
    let windowLogged = false;
    for (const intent of intents) {
      const now = valuationNow();
      if (!verticalEntryWindowOpen(now)) {
        if (!windowLogged) {
          ctx.log("auto paper vertical skip: no new verticals after 15:50 ET");
          windowLogged = true;
        }
        continue;
      }
      if (verticalStopCooling(ctx.verticalStopCooldown ?? {}, intent.symbol, now)) {
        ctx.log(`auto paper vertical skip ${intent.symbol}: cooling after stop`);
        continue;
      }
      try {
        const expiries = await ctx.fetchExpiries(intent.symbol);
        const picked = pickTargetExpiry(expiries);
        if (!picked) {
          ctx.log(`auto paper vertical skip ${intent.symbol}: no 30–45 DTE expiry`);
          continue;
        }
        const legs = await ctx.fetchChain(intent.symbol, picked.expiry);
        const pair = pickAtmCallDebit(legs, intent.last);
        if (!pair) {
          ctx.log(`auto paper vertical skip ${intent.symbol}: no ATM call debit`);
          continue;
        }
        if (pair.long.right !== "C" || pair.short.right !== "C") {
          ctx.log(`auto paper vertical skip ${intent.symbol}: refuses puts`);
          continue;
        }
        const v: AutoVertical = {
          sleeveId: "options",
          symbol: intent.symbol,
          right: "C",
          expiry: picked.expiry,
          longStrike: pair.long.strike,
          shortStrike: pair.short.strike,
          thesis: intent.thesis,
        };
        const r = await ctx.placeVertical(v);
        if (r.ok) {
          ctx.log(
            `auto paper call debit ${v.symbol} ${v.longStrike}/${v.shortStrike} C ${v.expiry} ${v.thesis} (MockBroker, not live, not E*TRADE order)`,
          );
          verticals.push(v);
        } else if (/bid\/ask/i.test(r.error)) {
          ctx.log(`auto paper vertical skip ${intent.symbol} missing bid/ask`);
        } else {
          ctx.log(`auto paper vertical skip ${intent.symbol}: ${r.error}`);
        }
      } catch (err) {
        ctx.log(
          `auto paper vertical skip ${intent.symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (
    riskoffPutsAllowed(riskOn, putChecks) &&
    ctx.placeVertical &&
    ctx.fetchExpiries &&
    ctx.fetchChain
  ) {
    const intents = decidePutVerticalIntents(
      ctx.riskoffQuotes ?? [],
      ctx.getPositions(),
      ctx.getSleeves().riskoff,
      riskOn,
      putChecks,
    );
    let windowLogged = false;
    for (const intent of intents) {
      const now = valuationNow();
      if (!verticalEntryWindowOpen(now)) {
        if (!windowLogged) {
          ctx.log("auto paper vertical skip: no new verticals after 15:50 ET");
          windowLogged = true;
        }
        continue;
      }
      if (verticalStopCooling(ctx.verticalStopCooldown ?? {}, intent.symbol, now)) {
        ctx.log(`auto paper vertical skip ${intent.symbol}: cooling after stop`);
        continue;
      }
      try {
        const expiries = await ctx.fetchExpiries(intent.symbol);
        const picked = pickTargetExpiry(expiries);
        if (!picked) {
          ctx.log(`auto paper vertical skip ${intent.symbol}: no 30–45 DTE expiry`);
          continue;
        }
        const legs = await ctx.fetchChain(intent.symbol, picked.expiry);
        const pair = pickAtmPutDebit(legs, intent.last);
        if (!pair) {
          ctx.log(`auto paper vertical skip ${intent.symbol}: no ATM put debit`);
          continue;
        }
        if (pair.long.right !== "P" || pair.short.right !== "P") {
          ctx.log(`auto paper vertical skip ${intent.symbol}: refuses calls`);
          continue;
        }
        const v: AutoVertical = {
          sleeveId: "riskoff",
          symbol: intent.symbol,
          right: "P",
          expiry: picked.expiry,
          longStrike: pair.long.strike,
          shortStrike: pair.short.strike,
          thesis: intent.thesis,
        };
        const r = await ctx.placeVertical(v);
        if (r.ok) {
          ctx.log(
            `auto paper put debit ${v.symbol} ${v.longStrike}/${v.shortStrike} P ${v.expiry} ${v.thesis} (MockBroker, not live, not E*TRADE order)`,
          );
          verticals.push(v);
        } else if (/bid\/ask/i.test(r.error)) {
          ctx.log(`auto paper vertical skip ${intent.symbol} missing bid/ask`);
        } else {
          ctx.log(`auto paper vertical skip ${intent.symbol}: ${r.error}`);
        }
      } catch (err) {
        ctx.log(
          `auto paper vertical skip ${intent.symbol}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  await placeRiskoffEtfBuy(ctx, etf.buy, bought);
  return { bought, sold, verticals };
}

async function placeRiskoffEtfBuy(
  ctx: AutopilotCtx,
  buy: AutoBuy | null,
  bought: AutoBuy[],
): Promise<void> {
  if (!buy) return;
  const leftover = openRiskoffEtfPositions(ctx.getPositions()).filter(
    (p) => p.symbol.toUpperCase() !== buy.symbol.toUpperCase(),
  );
  if (leftover.length) {
    ctx.log(
      `auto paper skip ${buy.symbol}: still holding ${leftover.map((p) => p.symbol).join(",")}`,
    );
    return;
  }
  if (
    openRiskoffEtfPositions(ctx.getPositions()).some(
      (p) => p.symbol.toUpperCase() === buy.symbol.toUpperCase(),
    )
  ) {
    return;
  }
  const r = await ctx.place(buy);
  if (r.ok) {
    ctx.log(
      `auto paper buy ${buy.sleeveId} ${buy.qty} ${buy.symbol} stop ${buy.stopPrice} ${buy.thesis} (MockBroker, not Tradovate, not live)`,
    );
    bought.push(buy);
  } else if (/no delayed last/i.test(r.error)) {
    ctx.log(`auto paper skip ${buy.symbol} no delayed last`);
  } else {
    ctx.log(`auto paper skip ${buy.symbol}: ${r.error}`);
  }
}
