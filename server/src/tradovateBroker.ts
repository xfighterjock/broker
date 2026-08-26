import { DEMO_TRADOVATE_BASE, DEMO_TRADOVATE_HOST } from "../../shared/constants";
import type { Position, WorkingOrder } from "../../shared/types";
import type { BrokerClient } from "./broker";

export class LiveTradovateRefusedError extends Error {
  constructor(host: string) {
    super(
      `[EventGate] refusing live Tradovate host "${host}". Demo only: ${DEMO_TRADOVATE_BASE}`,
    );
    this.name = "LiveTradovateRefusedError";
  }
}

export interface TradovateConfig {
  baseUrl?: string;
  username?: string;
  password?: string;
  appId?: string;
  appVersion?: string;
  cid?: string;
  secret?: string;
}

export function assertDemoTradovateUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`[EventGate] invalid Tradovate URL: ${baseUrl}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host.includes("live")) {
    throw new LiveTradovateRefusedError(host);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`[EventGate] Tradovate URL must be https, got ${parsed.protocol}`);
  }
  if (host !== DEMO_TRADOVATE_HOST) {
    throw new Error(
      `[EventGate] TradovateDemoBroker only talks to ${DEMO_TRADOVATE_HOST}, got ${host}`,
    );
  }
  return parsed;
}

/**
 * STUB. REST-only against https://demo.tradovateapi.com/v1.
 * Does not implement a full order/position adapter. MockBroker remains the default.
 * Construction is the live-host hard gate — tests cover that.
 */
export class TradovateDemoBroker implements BrokerClient {
  readonly name = "TradovateDemoBroker (stub)";
  readonly mode = "demo" as const;
  readonly liveRefused = false;
  readonly stub = true;
  readonly baseUrl: string;

  constructor(config: TradovateConfig = {}) {
    const url = config.baseUrl || DEMO_TRADOVATE_BASE;
    assertDemoTradovateUrl(url);
    this.baseUrl = url.replace(/\/+$/, "");
  }

  async getOrders(): Promise<WorkingOrder[]> {
    throw new Error(
      "[EventGate] TradovateDemoBroker is a stub — list orders is not wired. Keep TRADING_MODE=mock.",
    );
  }

  async getPositions(): Promise<Position[]> {
    throw new Error(
      "[EventGate] TradovateDemoBroker is a stub — list positions is not wired. Keep TRADING_MODE=mock.",
    );
  }

  async cancelOrders(): Promise<WorkingOrder[]> {
    throw new Error(
      "[EventGate] TradovateDemoBroker is a stub — cancel is not wired. Keep TRADING_MODE=mock.",
    );
  }

  async flattenSymbols(): Promise<Position[]> {
    throw new Error(
      "[EventGate] TradovateDemoBroker is a stub — flatten is not wired. Keep TRADING_MODE=mock.",
    );
  }

  getDayPnl(): number {
    return 0;
  }
}

export function createTradovateFromEnv(): TradovateDemoBroker {
  const mode = (process.env.TRADING_MODE || "mock").toLowerCase();
  if (mode === "live") {
    throw new Error("[EventGate] TRADING_MODE=live is refused. Paper/demo only.");
  }
  const baseUrl = process.env.TRADOVATE_BASE_URL || DEMO_TRADOVATE_BASE;
  return new TradovateDemoBroker({
    baseUrl,
    username: process.env.TRADOVATE_USER,
    password: process.env.TRADOVATE_PASSWORD,
    appId: process.env.TRADOVATE_APP_ID,
    appVersion: process.env.TRADOVATE_APP_VERSION || "1.0",
    cid: process.env.TRADOVATE_CID,
    secret: process.env.TRADOVATE_SECRET,
  });
}
