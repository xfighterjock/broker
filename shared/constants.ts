export const TZ = "America/New_York";
export const TRADER = "Richard";

export const PRE_ARM_MS = 15 * 60 * 1000;
export const BAND_MS = 2 * 60 * 1000;
export const FLATTEN_WINDOW_MS = 5 * 60 * 1000;
export const MAX_QTY = 1;
export const DEFAULT_DAILY_LOSS_USD = 500;

export const GATED_ROOTS = [
  "MES",
  "MNQ",
  "ES",
  "NQ",
  "ZN",
  "ZF",
  "ZT",
  "ZB",
  "SR3",
  "6E",
  "M6E",
] as const;

export type GatedRoot = (typeof GATED_ROOTS)[number];

/** Longest-first so MES wins over ES, M6E over 6E, MNQ over NQ. */
export const GATED_ROOTS_LONGEST: string[] = [...GATED_ROOTS].sort(
  (a, b) => b.length - a.length,
);

export const ORDER_TYPES = [
  "Market",
  "StopMarket",
  "StopLimit",
  "MIT",
  "Limit",
] as const;

export type OrderType = (typeof ORDER_TYPES)[number];

export const MARKET_OR_STOP: ReadonlySet<string> = new Set([
  "Market",
  "StopMarket",
  "StopLimit",
  "MIT",
]);

export const DEMO_TRADOVATE_HOST = "demo.tradovateapi.com";
export const DEMO_TRADOVATE_BASE = "https://demo.tradovateapi.com/v1";

export const SLEEVE_IDS = ["day", "momentum", "options", "ownership", "riskoff"] as const;

export const REDIS_KEYS = {
  gateEnabled: "gate:enabled",
  dailyLoss: "gate:daily_loss",
  mockOrders: "mock:orders",
  mockPositions: "mock:positions",
  mockDayPnl: "mock:day_pnl",
  flattenFired: "gate:flatten_fired",
  sleeves: "sleeves:cards",
  blotter: "sleeves:blotter",
  scanUniverse: "scan:universe",
  scanFeatures: "scan:features",
  /** JSON `{ day, momentum, options, ownership, riskoff }`. Legacy `0`/`1` migrates on first boot. */
  autoPaper: "paper:auto",
  sessionMarks: "sleeves:session_marks",
  verticalStopCooldown: "paper:vertical_stop_cooldown",
  /** Last published RISK ON/OFF (`1`/`0`) so a process restart does not false-flip FCM. */
  riskOn: "risk:on",
} as const;

/** Independent mock starting equity per sleeve (day, momentum, options, ownership, riskoff). */
export const DEFAULT_SLEEVE_EQUITY_USD = 100_000;

/** Extra autopilot pass for sells while the scan cache is warm. */
export const AUTO_PAPER_INTERVAL_MS = 5 * 60 * 1000;

export const REDIS_CHANNELS = {
  log: "eventgate:log",
  status: "eventgate:status",
} as const;

/** Default quote-strip names. Live chains accept any US equity/ETF (not a gate). */
export const OPTIONS_V1_SYMBOLS = ["SPY", "QQQ", "IWM"] as const;
export type OptionsV1Symbol = (typeof OPTIONS_V1_SYMBOLS)[number];

export const MASSIVE_BASE = "https://api.massive.com";
/** Options-sleeve auto debit-call cap (3–5). */
export const MAX_AUTO_VERTICALS = 5;
/** Risk-off sleeve auto put-debit cap (2–3). One per name. */
export const MAX_AUTO_RISKOFF_VERTICALS = 3;
/** Risk-off auto equity-index underlyers. IWM is optional third if quoted. */
export const RISKOFF_SYMBOLS = ["SPY", "QQQ"] as const;
export type RiskoffSymbol = (typeof RISKOFF_SYMBOLS)[number];
/** Credit-leg put debit when HYG is below 200dma. Not an inverse ETF. */
export const RISKOFF_HYG_SYMBOL = "HYG";
/**
 * Credit-leg put underlyers. Each name may open a put debit when RISK
 * OFF and that name is below its own 200dma. ATM first, then the liquid-strike
 * ladder (±2 then next 30–45 DTE expiries). Fill order HYG, then LQD, then
 * JNK. Not inverse ETFs. SJB is never in this list.
 */
export const RISKOFF_CREDIT_LEG_SYMBOLS = ["HYG", "LQD", "JNK"] as const;
export type RiskoffCreditLegSymbol = (typeof RISKOFF_CREDIT_LEG_SYMBOLS)[number];
/**
 * Credit-leg auto put debits are uniquely cheap and thin: a small net debit
 * makes OPTIONS_DEBIT_TARGET_FRAC (1% sizing) produce huge contract counts,
 * and the two-strike chain around it is often barely quoted. Incident
 * 2026-09-03: HYG 79/78.5P, open interest 7/0, auto-sized to 50 contracts on
 * a 0.20 net debit, 50% debit stop fired within 40 minutes for a large loss
 * (see docs/DESIGN.md). These three constants gate HYG/LQD/JNK riskoff AUTO
 * entries only — SPY/QQQ/IWM riskoff puts, options-sleeve call debits, and
 * manual POST /api/paper/vertical are unaffected.
 */
/** Both credit-leg put legs need at least this much open interest, or the auto entry is refused. */
export const RISKOFF_HYG_MIN_OPEN_INTEREST = 100;
/** Refuse the credit-leg auto entry if the immediate round-trip (sell long at bid, buy back short at ask) would already give back more than this fraction of the entry debit — i.e. refuse when immediate close < 75% of entry debit. */
export const RISKOFF_HYG_MAX_ROUNDTRIP_SLIPPAGE_FRAC = 0.25;
/** Hard cap on credit-leg auto put-debit contracts. Overrides OPTIONS_DEBIT_TARGET_FRAC 1% sizing, which is what produced 50 contracts on a 0.20 debit. */
export const RISKOFF_HYG_MAX_AUTO_QTY = 3;
/** Same numbers as RISKOFF_HYG_*; aliases so LQD/JNK share the HYG envelope. */
export const RISKOFF_CREDIT_LEG_MIN_OPEN_INTEREST = RISKOFF_HYG_MIN_OPEN_INTEREST;
export const RISKOFF_CREDIT_LEG_MAX_ROUNDTRIP_SLIPPAGE_FRAC =
  RISKOFF_HYG_MAX_ROUNDTRIP_SLIPPAGE_FRAC;
export const RISKOFF_CREDIT_LEG_MAX_AUTO_QTY = RISKOFF_HYG_MAX_AUTO_QTY;
/**
 * Credit-leg AUTO liquid-strike ladder (HYG/LQD/JNK paper puts only).
 * When the ATM pair fails the OI / 75% close-value gate, walk this many
 * strikes either side of ATM (order 0, +1, −1, +2, −2) then the next
 * 30–45 DTE expiries. Same gate and qty≤3 on every candidate. SPY/QQQ/IWM
 * stay ATM-only.
 */
export const RISKOFF_CREDIT_LEG_STRIKE_OFFSETS = 2;
/** Credit-leg AUTO: try this many 30–45 DTE expiries (closest to band midpoint first; same scoring as pickTargetExpiry). */
export const RISKOFF_CREDIT_LEG_EXPIRY_CANDIDATES = 3;
/**
 * Risk-off quote strip (visibility). Puts are SPY/QQQ/IWM + HYG/LQD/JNK.
 * SJB is visibility-only — not a traded inverse.
 */
export const RISKOFF_QUOTE_STRIP = [
  "SPY",
  "QQQ",
  "HYG",
  "GLD",
  "UUP",
  "BIL",
  "TLT",
  "IEF",
  "XLU",
  "XLP",
  "DBMF",
  "LQD",
  "JNK",
  "SJB",
] as const;
export type RiskoffQuoteSymbol = (typeof RISKOFF_QUOTE_STRIP)[number];
/**
 * Second risk-off expression: one ETF long vs BIL. Paper only.
 * Preference order for an exact RS tie: GLD > UUP > duration (TLT, IEF)
 * > defensives (XLU, XLP) > trend (DBMF). BIL is the cash/T-bill benchmark, last.
 */
export const RISKOFF_ETF_SYMBOLS = ["GLD", "UUP", "TLT", "IEF", "XLU", "XLP", "DBMF", "BIL"] as const;
export type RiskoffEtfSymbol = (typeof RISKOFF_ETF_SYMBOLS)[number];
export const RISKOFF_ETF_CASH_SYMBOL: RiskoffEtfSymbol = "BIL";
export const RISKOFF_ETF_CANDIDATES = RISKOFF_ETF_SYMBOLS.filter(
  (s): s is Exclude<RiskoffEtfSymbol, "BIL"> => s !== "BIL",
);
/**
 * Exact trading-day total-return lookback for the risk-off ETF overlay vs BIL.
 * 63 sessions ≈ 3 months — same convention as scan `ret63`, and clearly
 * multi-month (not the 20-session UUP dollar veto on the global gate).
 */
export const RISKOFF_ETF_LOOKBACK_DAYS = 63;
/**
 * Fraction of the $100k risk-off mock book for the ETF long (~$40k).
 * Puts keep the rest of the sleeve. Paper step toward half the sleeve
 * (not a full 50%). Easy to change.
 */
export const RISKOFF_ETF_NOTIONAL_FRAC = 0.40;
/** Disaster stop on the ETF long. Rotation — not this stop — is the primary exit. */
export const RISKOFF_ETF_STOP_MUL = 0.92;
/** Prefer 30–45 DTE, always above OPTIONS_DTE_EXIT. */
export const OPTIONS_DTE_TARGET_MIN = 30;
export const OPTIONS_DTE_TARGET_MAX = 45;

export const OPTIONS_MULTIPLIER = 100;
/** Prefer size so net debit is near this fraction of sleeve equity. */
export const OPTIONS_DEBIT_TARGET_FRAC = 0.01;
/** Hard cap: refuse if net debit would exceed this fraction of sleeve equity. */
export const OPTIONS_DEBIT_CAP_FRAC = 0.02;
/** Close the vertical when calendar DTE is at or below this. */
export const OPTIONS_DTE_EXIT = 21;
export const OPTIONS_PROFIT_TAKE_FRAC = 0.5;
export const OPTIONS_DEBIT_STOP_FRAC = 0.5;
/** Refuse a debit vertical when net debit / width exceeds this (equal-to-half is OK). */
export const OPTIONS_DEBIT_MAX_WIDTH_FRAC = 0.5;
/** No new paper verticals at or after this many ET minutes (15:50). Mon–Fri only. */
export const OPTIONS_VERTICAL_CUTOFF_MINUTES = 15 * 60 + 50;

export const ETRADE_SANDBOX_BASE = "https://apisb.etrade.com";
export const ETRADE_PROD_BASE = "https://api.etrade.com";
