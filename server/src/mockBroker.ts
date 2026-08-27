import { extractRoot, isGatedSymbol } from "../../shared/clock";
import type { OrderType } from "../../shared/constants";
import { REDIS_KEYS } from "../../shared/constants";
import type { Position, WorkingOrder } from "../../shared/types";
import type {
  BrokerClient,
  InjectOrderInput,
  InjectPositionInput,
} from "./broker";
import type { RedisClient } from "./redis";

function nid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * In-memory mock book. Optionally persists to Redis so a refresh keeps
 * working orders/positions. Tests construct without Redis.
 */
export class MockBroker implements BrokerClient {
  readonly name = "MockBroker";
  readonly mode = "mock" as const;
  readonly liveRefused = false;

  private orders: WorkingOrder[] = [];
  private positions: Position[] = [];
  private dayPnl = 0;
  private redis: RedisClient | null = null;

  attachRedis(redis: RedisClient): void {
    this.redis = redis;
  }

  async loadFromRedis(): Promise<void> {
    if (!this.redis) return;
    const [o, p, pnl] = await Promise.all([
      this.redis.get(REDIS_KEYS.mockOrders),
      this.redis.get(REDIS_KEYS.mockPositions),
      this.redis.get(REDIS_KEYS.mockDayPnl),
    ]);
    if (o) {
      try {
        this.orders = JSON.parse(o) as WorkingOrder[];
      } catch {
        /* ignore */
      }
    }
    if (p) {
      try {
        this.positions = JSON.parse(p) as Position[];
      } catch {
        /* ignore */
      }
    }
    if (pnl !== null && pnl !== undefined && pnl !== "") {
      const n = Number(pnl);
      if (Number.isFinite(n)) this.dayPnl = n;
    }
  }

  private persist(): void {
    if (!this.redis) return;
    void this.redis.set(REDIS_KEYS.mockOrders, JSON.stringify(this.orders));
    void this.redis.set(REDIS_KEYS.mockPositions, JSON.stringify(this.positions));
    void this.redis.set(REDIS_KEYS.mockDayPnl, String(this.dayPnl));
  }

  getOrders(): Promise<WorkingOrder[]> {
    return Promise.resolve(this.orders.map((o) => ({ ...o })));
  }

  getPositions(): Promise<Position[]> {
    return Promise.resolve(this.positions.map((p) => ({ ...p })));
  }

  getOrdersSync(): WorkingOrder[] {
    return this.orders.map((o) => ({ ...o }));
  }

  getPositionsSync(): Position[] {
    return this.positions.map((p) => ({ ...p }));
  }

  getDayPnl(): number {
    const u = this.positions.reduce((s, p) => s + p.unrealizedPnl, 0);
    return this.dayPnl + u;
  }

  setDayPnl(pnl: number): void {
    this.dayPnl = pnl;
    this.persist();
  }

  injectOrder(input: InjectOrderInput): WorkingOrder {
    const root = extractRoot(input.symbol);
    const order: WorkingOrder = {
      id: nid("ord"),
      symbol: input.symbol,
      root,
      type: input.type as OrderType,
      side: input.side,
      qty: input.qty,
      price: input.price,
      stopPrice: input.stopPrice,
      state: "Working",
      gated: isGatedSymbol(input.symbol),
      sleeveId: input.sleeveId,
    };
    this.orders.push(order);
    this.persist();
    return { ...order };
  }

  injectPosition(input: InjectPositionInput): Position {
    const root = extractRoot(input.symbol);
    const pos: Position = {
      id: nid("pos"),
      symbol: input.symbol,
      root,
      qty: input.qty,
      side: input.side,
      avgPrice: input.avgPrice ?? 0,
      unrealizedPnl: input.unrealizedPnl ?? 0,
      gated: isGatedSymbol(input.symbol),
      sleeveId: input.sleeveId,
    };
    this.positions = this.positions.filter((p) => p.symbol !== input.symbol);
    this.positions.push(pos);
    this.persist();
    return { ...pos };
  }

  async cancelOrders(ids: string[], _reason: string): Promise<WorkingOrder[]> {
    const cancelled: WorkingOrder[] = [];
    for (const o of this.orders) {
      if (
        ids.includes(o.id) &&
        (o.state === "Working" || o.state === "Submitted" || o.state === "Accepted")
      ) {
        o.state = "Cancelled";
        cancelled.push({ ...o });
      }
    }
    this.persist();
    return cancelled;
  }

  async flattenSymbols(symbols: string[], _reason: string): Promise<Position[]> {
    const want = new Set(symbols.map((s) => s.toUpperCase()));
    const flat: Position[] = [];
    for (const p of this.positions) {
      if (p.side === "Flat") continue;
      const hit =
        want.has(p.symbol.toUpperCase()) ||
        (p.root !== null && want.has(p.root));
      if (!hit) continue;
      p.qty = 0;
      p.side = "Flat";
      p.unrealizedPnl = 0;
      flat.push({ ...p });
    }
    for (const o of this.orders) {
      if (o.state !== "Working" && o.state !== "Submitted" && o.state !== "Accepted") continue;
      const hit =
        want.has(o.symbol.toUpperCase()) ||
        (o.root !== null && want.has(o.root));
      if (hit) o.state = "Cancelled";
    }
    this.persist();
    return flat;
  }

  setUnrealizedPnl(symbol: string, pnl: number): void {
    const want = symbol.toUpperCase();
    for (const p of this.positions) {
      if (p.side === "Flat") continue;
      if (p.symbol.toUpperCase() === want || (p.root !== null && p.root === want)) {
        p.unrealizedPnl = pnl;
      }
    }
    this.persist();
  }

  addRealizedPnl(delta: number): void {
    this.dayPnl += delta;
    this.persist();
  }

  reset(): void {
    this.orders = [];
    this.positions = [];
    this.dayPnl = 0;
    this.persist();
  }
}
