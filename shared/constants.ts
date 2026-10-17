export const TZ = "America/New_York";
export const TRADER = "Richard";

export const PRE_ARM_MS = 15 * 60 * 1000;
export const BAND_MS = 2 * 60 * 1000;
export const FLATTEN_WINDOW_MS = 5 * 60 * 1000;
export const MAX_QTY = 1;
export const DEFAULT_DAILY_LOSS_USD = 500;

/**
 * Paper CPI-day late-session fade (`cpiLateFade`) on the day sleeve.
 * Default on. Set false to stop new entries. An open lot still flattens
 * at the cash close. MockBroker only. Does not touch live broker paths.
 */
export const CPI_LATE_FADE_ENABLED = true;

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

export const SLEEVE_IDS = ["day", "momentum", "options", "ownership", "csp"] as const;

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
  /** JSON `{ day, momentum, options, ownership, csp }`. Legacy `0`/`1` migrates on first boot. Absent `csp` becomes true. */
  autoPaper: "paper:auto",
  sessionMarks: "sleeves:session_marks",
  verticalStopCooldown: "paper:vertical_stop_cooldown",
  /** Last published RISK ON/OFF (`1`/`0`) so a process restart does not false-flip FCM. */
  riskOn: "risk:on",
  /** JSON string[] of keys already credited on the deleted risk-off book. Purged on boot. */
  riskoffDistributions: "paper:riskoff_distributions",
  /** CSP betas, pending signals, and recorder slots. */
  cspState: "paper:csp_state",
} as const;

/** Independent mock starting equity per sleeve (day, momentum, options, ownership, csp). */
export const DEFAULT_SLEEVE_EQUITY_USD = 100_000;

/** Extra autopilot pass for sells while the scan cache is warm. */
export const AUTO_PAPER_INTERVAL_MS = 5 * 60 * 1000;

/** Drop gate_log and session_logs rows older than this. Nominal 3 months. */
export const ACTIVITY_LOG_RETENTION_DAYS = 90;
/** First page / scroll page size for GET /api/activity. */
export const ACTIVITY_LOG_PAGE_DEFAULT = 50;
export const ACTIVITY_LOG_PAGE_MAX = 100;

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
