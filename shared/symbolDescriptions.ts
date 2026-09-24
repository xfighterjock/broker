import { GATED_ROOTS_LONGEST } from "./constants";

/**
 * Short full name for Event Gate methodology tickers and gated futures roots.
 * Seeded from docs/ABBREVIATIONS.md / docs/DESIGN.md. Paper UI hover only —
 * not an order, quote, or sleeve rule. Unknown symbols stay unlabeled.
 */
export const SYMBOL_DESCRIPTIONS: Readonly<Record<string, string>> = {
  MES: "CME Micro E-mini S&P 500 futures",
  MNQ: "CME Micro E-mini Nasdaq-100 futures",
  ES: "CME E-mini S&P 500 futures",
  NQ: "CME E-mini Nasdaq-100 futures",
  ZN: "CME 10-Year U.S. Treasury Note futures",
  ZF: "CME 5-Year U.S. Treasury Note futures",
  ZT: "CME 2-Year U.S. Treasury Note futures",
  ZB: "CME 30-Year U.S. Treasury Bond futures",
  SR3: "CME Three-Month SOFR futures",
  "6E": "CME Euro FX futures",
  M6E: "CME Micro Euro FX futures",
  SPY: "SPDR S&P 500 ETF Trust",
  QQQ: "Invesco QQQ Trust (Nasdaq-100)",
  IWM: "iShares Russell 2000 ETF",
  HYG: "iShares iBoxx $ High Yield Corporate Bond ETF",
  LQD: "iShares iBoxx $ Investment Grade Corporate Bond ETF",
  JNK: "SPDR Bloomberg High Yield Bond ETF",
  SJB: "ProShares Short High Yield",
  GLD: "SPDR Gold Shares",
  GDX: "VanEck Gold Miners ETF",
  PDBC: "Invesco Optimum Yield Diversified Commodity Strategy ETF",
  UUP: "Invesco DB US Dollar Index Bullish Fund",
  BIL: "SPDR Bloomberg 1-3 Month T-Bill ETF",
  TLT: "iShares 20+ Year Treasury Bond ETF",
  IEF: "iShares 7-10 Year Treasury Bond ETF",
  XLU: "Utilities Select Sector SPDR Fund",
  XLP: "Consumer Staples Select Sector SPDR Fund",
  DBMF: "iMGP DBi Managed Futures Strategy ETF",
  KMLM: "KFA Mount Lucas Managed Futures Index Strategy ETF",
  CLSE: "Convergence Long/Short Equity ETF",
  USMV: "iShares MSCI USA Min Vol Factor ETF",
  FTLS: "First Trust Long/Short Equity ETF",
  ACWI: "iShares MSCI ACWI ETF",
};

/** CME month code + 1–2 digit year (MESU6, ESH26). Not a bare equity ticker. */
const FUTURES_MONTH_YEAR = /^[FGHJKMNQUVXZ]\d{1,2}$/;

function normalizeSymbol(raw: string): string {
  return raw.trim().toUpperCase().replace(/^F:/, "").replace(/=F$/, "");
}

function exactDescription(symbol: string): string | null {
  return SYMBOL_DESCRIPTIONS[symbol] ?? null;
}

/** Dated futures only. Longest root first so MES beats ES and M6E beats 6E. */
function futuresContractRoot(symbol: string): string | null {
  const compact = symbol.replace(/[^A-Z0-9]/g, "");
  for (const root of GATED_ROOTS_LONGEST) {
    if (!compact.startsWith(root)) continue;
    const rest = compact.slice(root.length);
    if (FUTURES_MONTH_YEAR.test(rest)) return root;
  }
  return null;
}

/**
 * Full name for a displayed ticker, dated future, Yahoo `=F` root, or option
 * package / OSI whose underlying is in SYMBOL_DESCRIPTIONS.
 * Unknown symbols return null (render the bare ticker, no tooltip).
 */
export function symbolDescription(symbol: string): string | null {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return null;
  const exact = exactDescription(normalized);
  if (exact) return exact;
  const dated = futuresContractRoot(normalized);
  if (dated) return exactDescription(dated);
  const first = normalized.split(/[\s/]+/).find(Boolean);
  if (first && first !== normalized) {
    const fromToken = symbolDescription(first);
    if (fromToken) return fromToken;
  }
  const lead = normalized.match(/^([A-Z]{1,5})(?=\d)/);
  if (lead) return exactDescription(lead[1]);
  return null;
}

/** HTML `title` / accessibility hint. Omitted when the symbol is unknown. */
export function symbolHoverTitle(symbol: string): string | undefined {
  return symbolDescription(symbol) ?? undefined;
}

/** Sleeve instruments field (`MES / ZN / M6E / SR3`) into display tokens. */
export function splitInstrumentLabels(instruments: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of instruments.split(/[,/\s]+/)) {
    const token = part.trim();
    if (!token) continue;
    const key = token.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}
