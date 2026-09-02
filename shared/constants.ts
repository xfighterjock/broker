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
  autoPaper: "paper:auto",
  sessionMarks: "sleeves:session_marks",
  verticalStopCooldown: "paper:vertical_stop_cooldown",
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
 * Second risk-off expression: one ETF long (GLD or UUP or BIL). Paper only.
 * Classic gold-vs-dollar relative strength vs T-bills.
 */
export const RISKOFF_ETF_SYMBOLS = ["GLD", "UUP", "BIL"] as const;
export type RiskoffEtfSymbol = (typeof RISKOFF_ETF_SYMBOLS)[number];
/**
 * Exact trading-day total-return lookback for GLD vs UUP vs BIL.
 * 63 sessions ≈ 3 months — same convention as scan `ret63`, and clearly
 * multi-month (not the 20-session UUP dollar veto on the global gate).
 */
export const RISKOFF_ETF_LOOKBACK_DAYS = 63;
/**
 * Fraction of the $100k risk-off mock book for the ETF long (~$20k).
 * Puts keep the rest of the sleeve. Easy to change.
 */
export const RISKOFF_ETF_NOTIONAL_FRAC = 0.20;
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
