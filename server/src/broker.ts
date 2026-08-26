import type { Position, WorkingOrder } from "../../shared/types";
import type { OrderType } from "../../shared/constants";

export interface InjectOrderInput {
  symbol: string;
  type: OrderType;
  side: "Buy" | "Sell";
  qty: number;
  price?: number;
  stopPrice?: number;
}

export interface InjectPositionInput {
  symbol: string;
  qty: number;
  side: "Long" | "Short";
  avgPrice?: number;
  unrealizedPnl?: number;
}

export interface BrokerClient {
  readonly name: string;
  readonly mode: "mock" | "demo";
  readonly liveRefused: boolean;
  getOrders(): Promise<WorkingOrder[]>;
  getPositions(): Promise<Position[]>;
  cancelOrders(ids: string[], reason: string): Promise<WorkingOrder[]>;
  flattenSymbols(symbols: string[], reason: string): Promise<Position[]>;
  getDayPnl(): number;
  setDayPnl?(pnl: number): void;
  injectOrder?(input: InjectOrderInput): WorkingOrder;
  injectPosition?(input: InjectPositionInput): Position;
}
