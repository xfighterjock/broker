import { computeClock, extractRoot } from "../../shared/clock";
import { MARKET_OR_STOP, MAX_QTY } from "../../shared/constants";
import type {
  CalendarEvent,
  GateAction,
  Position,
  WorkingOrder,
} from "../../shared/types";
import type { BrokerClient } from "./broker";

export interface GateTickInput {
  now: Date;
  events: CalendarEvent[];
  orders: WorkingOrder[];
  positions: Position[];
  enabled: boolean;
  dailyLossUsd: number;
  dayPnl: number;
  flattenFiredKey: string | null;
  liveRefused: boolean;
}

export interface GateTickResult {
  actions: GateAction[];
  flattenFiredKey: string | null;
  mode: string;
}

function liveOrder(o: WorkingOrder): boolean {
  return o.state === "Working" || o.state === "Submitted" || o.state === "Accepted";
}

function etDayKey(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Pure gate decision. Tests inject `now` and mock book.
 * Priority: live refuse > always oversize > PRE-ARM/BAND cancel market-or-stop > session flatten / daily loss.
 * Limits are left alone unless oversize.
 */
export function planGateTick(input: GateTickInput): GateTickResult {
  const actions: GateAction[] = [];
  const clock = computeClock(input.now, input.events);
  const dayKey = etDayKey(input.now);
  let flattenFiredKey = input.flattenFiredKey;

  if (!input.enabled) {
    return { actions, flattenFiredKey, mode: clock.mode };
  }

  if (input.liveRefused) {
    actions.push({
      kind: "refuse",
      reason: "live host/account detected — no orders will be sent",
    });
    return { actions, flattenFiredKey, mode: clock.mode };
  }

  const gatedLive = input.orders.filter((o) => o.gated && liveOrder(o));
  const gatedPos = input.positions.filter((p) => p.gated && p.side !== "Flat" && p.qty > 0);

  for (const o of gatedLive) {
    if (o.qty > MAX_QTY) {
      actions.push({
        kind: "cancel",
        orderId: o.id,
        reason: `oversize qty ${o.qty} on ${o.symbol}`,
      });
    }
  }

  for (const p of gatedPos) {
    if (p.qty > MAX_QTY) {
      actions.push({
        kind: "flatten",
        symbol: p.symbol,
        reason: `oversize position qty ${p.qty} on ${p.symbol}`,
      });
    }
  }

  if (clock.inPreArm || clock.inBand) {
    const windowName = clock.inBand ? "NO-STOP BAND" : "PRE-ARM";
    for (const o of gatedLive) {
      if (!MARKET_OR_STOP.has(o.type)) continue;
      if (actions.some((a) => a.kind === "cancel" && a.orderId === o.id)) continue;
      actions.push({
        kind: "cancel",
        orderId: o.id,
        reason: `${o.type} ${o.symbol} in ${windowName}`,
      });
    }
  }

  const hitLoss =
    input.dailyLossUsd > 0 && input.dayPnl <= -Math.abs(input.dailyLossUsd);
  const hitClose = clock.inSessionFlatten;
  const already = flattenFiredKey === dayKey;

  if ((hitLoss || hitClose) && !already) {
    flattenFiredKey = dayKey;
    const reason = hitLoss
      ? `daily loss ${input.dayPnl.toFixed(0)} (limit ${input.dailyLossUsd})`
      : `session flatten ${clock.flattenEt} ET`;
    const symbols = new Set<string>();
    for (const p of gatedPos) symbols.add(p.symbol);
    for (const o of gatedLive) symbols.add(o.symbol);
    if (symbols.size === 0) {
      actions.push({ kind: "log", message: `flatten (${reason}): nothing open` });
    } else {
      for (const symbol of symbols) {
        actions.push({ kind: "flatten", symbol, reason });
      }
    }
  }

  return { actions, flattenFiredKey, mode: clock.mode };
}

export type LogSink = (line: string, ts: string) => void;

export class GateEngine {
  enabled: boolean;
  dailyLossUsd: number;
  flattenFiredKey: string | null = null;
  onLog: LogSink | null = null;
  private logs: { ts: string; message: string }[] = [];

  constructor(
    private broker: BrokerClient,
    private getNow: () => Date,
    private getEvents: () => CalendarEvent[],
    opts?: { enabled?: boolean; dailyLossUsd?: number },
  ) {
    this.enabled = opts?.enabled ?? true;
    this.dailyLossUsd = opts?.dailyLossUsd ?? 500;
  }

  getLogs(): { ts: string; message: string }[] {
    return [...this.logs];
  }

  loadLogs(entries: { ts: string; message: string }[]): void {
    this.logs = entries.slice(-500);
  }

  log(message: string): void {
    const line = message.startsWith("[EventGate]")
      ? message
      : `[EventGate] ${message}`;
    const ts = this.getNow().toISOString();
    this.logs.push({ ts, message: line });
    if (this.logs.length > 500) this.logs.splice(0, this.logs.length - 500);
    this.onLog?.(line, ts);
  }

  async tick(): Promise<GateTickResult> {
    const now = this.getNow();
    const orders = await this.broker.getOrders();
    const positions = await this.broker.getPositions();
    const result = planGateTick({
      now,
      events: this.getEvents(),
      orders,
      positions,
      enabled: this.enabled,
      dailyLossUsd: this.dailyLossUsd,
      dayPnl: this.broker.getDayPnl(),
      flattenFiredKey: this.flattenFiredKey,
      liveRefused: this.broker.liveRefused,
    });
    this.flattenFiredKey = result.flattenFiredKey;
    await this.apply(result.actions);
    return result;
  }

  async flattenSleeve(reason: string): Promise<void> {
    if (this.broker.liveRefused) {
      this.log(`flatten refused: live host/account`);
      return;
    }
    const positions = await this.broker.getPositions();
    const orders = await this.broker.getOrders();
    const symbols = new Set<string>();
    for (const p of positions) {
      if (p.gated && p.side !== "Flat" && p.qty > 0) symbols.add(p.symbol);
    }
    for (const o of orders) {
      if (o.gated && (o.state === "Working" || o.state === "Submitted" || o.state === "Accepted")) {
        symbols.add(o.symbol);
      }
    }
    if (symbols.size === 0) {
      this.log(`flatten (${reason}): nothing open`);
      return;
    }
    await this.broker.flattenSymbols([...symbols], reason);
    this.log(`flatten (${reason}): ${symbols.size} instrument(s)`);
  }

  async cancelMarketStops(): Promise<void> {
    if (this.broker.liveRefused) {
      this.log(`cancel refused: live host/account`);
      return;
    }
    const orders = await this.broker.getOrders();
    const ids = orders
      .filter(
        (o) =>
          o.gated &&
          (o.state === "Working" || o.state === "Submitted" || o.state === "Accepted") &&
          MARKET_OR_STOP.has(o.type),
      )
      .map((o) => o.id);
    if (ids.length === 0) {
      this.log("cancel market/stops: none working");
      return;
    }
    const cancelled = await this.broker.cancelOrders(ids, "manual cancel market/stops");
    for (const o of cancelled) {
      this.log(`cancelled ${o.type} ${o.symbol} qty ${o.qty} (manual)`);
    }
  }

  private async apply(actions: GateAction[]): Promise<void> {
    const cancelIds: string[] = [];
    const cancelReasons = new Map<string, string>();
    const flattenSymbols: string[] = [];
    const flattenReasons = new Map<string, string>();

    for (const a of actions) {
      if (a.kind === "refuse") {
        this.log(`ERROR ${a.reason}`);
      } else if (a.kind === "log") {
        this.log(a.message);
      } else if (a.kind === "cancel") {
        cancelIds.push(a.orderId);
        cancelReasons.set(a.orderId, a.reason);
      } else if (a.kind === "flatten") {
        flattenSymbols.push(a.symbol);
        flattenReasons.set(a.symbol, a.reason);
      }
    }

    if (cancelIds.length > 0) {
      const cancelled = await this.broker.cancelOrders(cancelIds, "gate");
      for (const o of cancelled) {
        this.log(`cancelled ${o.type} ${o.symbol} qty ${o.qty} (${cancelReasons.get(o.id) ?? "gate"})`);
      }
    }
    if (flattenSymbols.length > 0) {
      const unique = [...new Set(flattenSymbols)];
      await this.broker.flattenSymbols(unique, "gate");
      for (const sym of unique) {
        this.log(`flatten ${sym} (${flattenReasons.get(sym) ?? "gate"})`);
      }
    }
  }
}

export { extractRoot };
