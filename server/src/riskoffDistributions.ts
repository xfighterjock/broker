import { RISKOFF_ETF_SYMBOLS } from "../../shared/constants";
import type { Position, SleeveId } from "../../shared/types";
import type { MassiveCashDividend } from "./massive";

const credited = new Set<string>();
/** Session checks that returned a list (including empty). Not a credit. */
const checked = new Set<string>();

export function resetRiskoffDistributionCredits(): void {
  credited.clear();
  checked.clear();
}

export function markDistributionChecked(key: string): void {
  checked.add(key);
}

export function distributionWasChecked(key: string): boolean {
  return checked.has(key);
}

export function distributionCreditKey(sleeveId: SleeveId, symbol: string, exDate: string): string {
  return `${sleeveId}|${symbol.trim().toUpperCase()}|${exDate}`;
}

export function rememberDistributionCredit(key: string): void {
  credited.add(key);
}

export function hasDistributionCredit(key: string): boolean {
  return credited.has(key);
}

export function listDistributionCredits(): string[] {
  return [...credited];
}

export function loadDistributionCredits(keys: readonly string[]): void {
  credited.clear();
  for (const key of keys) {
    if (typeof key === "string" && key.trim()) credited.add(key.trim());
  }
}

export type DistributionCredit = {
  key: string;
  sleeveId: "riskoff";
  symbol: string;
  exDate: string;
  qty: number;
  cashAmount: number;
  creditUsd: number;
  note: string;
};

function isCreditableEtf(p: Position): boolean {
  if (p.sleeveId !== "riskoff" || p.side !== "Long" || p.qty <= 0) return false;
  if (p.vertical || p.overlay) return false;
  const symbol = p.symbol.trim().toUpperCase();
  return (RISKOFF_ETF_SYMBOLS as readonly string[]).includes(symbol);
}

/** Share count of one risk-off ETF across overlay, sweep, and duration lots. */
export function riskoffEtfShareQty(positions: Position[], symbol: string): number {
  const want = symbol.trim().toUpperCase();
  let qty = 0;
  for (const p of positions) {
    if (!isCreditableEtf(p)) continue;
    if (p.symbol.trim().toUpperCase() !== want) continue;
    qty += p.qty;
  }
  return qty;
}

export function riskoffDistributionSymbols(positions: Position[]): string[] {
  const out: string[] = [];
  for (const p of positions) {
    if (!isCreditableEtf(p)) continue;
    const symbol = p.symbol.trim().toUpperCase();
    if (!out.includes(symbol)) out.push(symbol);
  }
  return out;
}

function cashText(n: number): string {
  const fixed = n.toFixed(4);
  return fixed.replace(/\.?0+$/, "");
}

/**
 * Credits for this NY session only. One row per (symbol, ex-date, sleeve).
 * Already-credited keys are skipped. Non-positive or non-matching rows are ignored.
 */
export function planRiskoffDistributionCredits(input: {
  positions: Position[];
  distributions: readonly MassiveCashDividend[];
  sessionDate: string;
  credited?: ReadonlySet<string>;
}): DistributionCredit[] {
  const seen = input.credited ?? credited;
  const out: DistributionCredit[] = [];
  const used = new Set<string>();
  for (const row of input.distributions) {
    if (row.exDate !== input.sessionDate) continue;
    if (!(row.cashAmount > 0) || !Number.isFinite(row.cashAmount)) continue;
    const symbol = row.ticker.trim().toUpperCase();
    const qty = riskoffEtfShareQty(input.positions, symbol);
    if (qty < 1) continue;
    const key = distributionCreditKey("riskoff", symbol, row.exDate);
    if (seen.has(key) || used.has(key)) continue;
    used.add(key);
    const creditUsd = Math.round(qty * row.cashAmount * 100) / 100;
    if (!(creditUsd > 0)) continue;
    out.push({
      key,
      sleeveId: "riskoff",
      symbol,
      exDate: row.exDate,
      qty,
      cashAmount: row.cashAmount,
      creditUsd,
      note: `distribution ${symbol} ex ${row.exDate} ${qty} sh × ${cashText(row.cashAmount)} credit ${creditUsd.toFixed(2)} ${key}`,
    });
  }
  return out;
}
