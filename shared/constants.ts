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

export const REDIS_KEYS = {
  gateEnabled: "gate:enabled",
  dailyLoss: "gate:daily_loss",
  mockOrders: "mock:orders",
  mockPositions: "mock:positions",
  mockDayPnl: "mock:day_pnl",
  flattenFired: "gate:flatten_fired",
} as const;

export const REDIS_CHANNELS = {
  log: "eventgate:log",
  status: "eventgate:status",
} as const;
