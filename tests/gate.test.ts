import { describe, expect, it } from "vitest";
import { seedEvents } from "../shared/clock";
import { GateEngine, planGateTick } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";

const events = seedEvents();
const PRINT = new Date("2026-09-04T12:30:00.000Z");
const PRE = new Date("2026-09-04T12:20:00.000Z");
const IDLE = new Date("2026-09-04T14:00:00.000Z");
const FLATTEN = new Date("2026-09-04T19:45:00.000Z");

describe("planGateTick", () => {
  it("cancels a working StopMarket in the no-stop band", () => {
    const broker = new MockBroker();
    const stop = broker.injectOrder({
      symbol: "MESU6",
      type: "StopMarket",
      side: "Buy",
      qty: 1,
      stopPrice: 5800,
    });
    const limit = broker.injectOrder({
      symbol: "ZNU6",
      type: "Limit",
      side: "Buy",
      qty: 1,
      price: 111,
    });
    const result = planGateTick({
      now: PRINT,
      events,
      orders: broker.getOrdersSync(),
      positions: broker.getPositionsSync(),
      enabled: true,
      dailyLossUsd: 500,
      dayPnl: 0,
      flattenFiredKey: null,
      liveRefused: false,
    });
    const cancels = result.actions.filter((a) => a.kind === "cancel");
    expect(cancels.map((a) => a.kind === "cancel" && a.orderId)).toContain(stop.id);
    expect(cancels.map((a) => a.kind === "cancel" && a.orderId)).not.toContain(limit.id);
  });

  it("also cancels market/stops in PRE-ARM", () => {
    const broker = new MockBroker();
    const mit = broker.injectOrder({
      symbol: "M6EU6",
      type: "MIT",
      side: "Sell",
      qty: 1,
    });
    const result = planGateTick({
      now: PRE,
      events,
      orders: broker.getOrdersSync(),
      positions: [],
      enabled: true,
      dailyLossUsd: 500,
      dayPnl: 0,
      flattenFiredKey: null,
      liveRefused: false,
    });
    expect(result.mode).toBe("PRE-ARM");
    expect(result.actions.some((a) => a.kind === "cancel" && a.orderId === mit.id)).toBe(true);
  });

  it("leaves Limit alone in-band unless oversize", () => {
    const broker = new MockBroker();
    broker.injectOrder({ symbol: "MESU6", type: "Limit", side: "Buy", qty: 1, price: 1 });
    const result = planGateTick({
      now: PRINT,
      events,
      orders: broker.getOrdersSync(),
      positions: [],
      enabled: true,
      dailyLossUsd: 500,
      dayPnl: 0,
      flattenFiredKey: null,
      liveRefused: false,
    });
    expect(result.actions.filter((a) => a.kind === "cancel")).toHaveLength(0);
  });

  it("always cancels oversize working orders", () => {
    const broker = new MockBroker();
    const big = broker.injectOrder({
      symbol: "MESU6",
      type: "Limit",
      side: "Buy",
      qty: 2,
      price: 1,
    });
    const result = planGateTick({
      now: IDLE,
      events,
      orders: broker.getOrdersSync(),
      positions: [],
      enabled: true,
      dailyLossUsd: 500,
      dayPnl: 0,
      flattenFiredKey: null,
      liveRefused: false,
    });
    expect(result.actions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "cancel", orderId: big.id }),
      ]),
    );
  });

  it("flattens gated instruments at session flatten", () => {
    const broker = new MockBroker();
    broker.injectPosition({ symbol: "MESU6", qty: 1, side: "Long", avgPrice: 5800 });
    const result = planGateTick({
      now: FLATTEN,
      events,
      orders: [],
      positions: broker.getPositionsSync(),
      enabled: true,
      dailyLossUsd: 500,
      dayPnl: 0,
      flattenFiredKey: null,
      liveRefused: false,
    });
    expect(result.mode).toBe("SESSION FLATTEN");
    expect(result.actions.some((a) => a.kind === "flatten" && a.symbol === "MESU6")).toBe(true);
  });

  it("flattens on daily loss", () => {
    const broker = new MockBroker();
    broker.injectPosition({ symbol: "SR3U6", qty: 1, side: "Short", avgPrice: 96 });
    const result = planGateTick({
      now: IDLE,
      events,
      orders: [],
      positions: broker.getPositionsSync(),
      enabled: true,
      dailyLossUsd: 500,
      dayPnl: -500,
      flattenFiredKey: null,
      liveRefused: false,
    });
    expect(result.actions.some((a) => a.kind === "flatten" && a.symbol === "SR3U6")).toBe(true);
  });

  it("refuses to send when live host detected", () => {
    const result = planGateTick({
      now: PRINT,
      events,
      orders: [],
      positions: [],
      enabled: true,
      dailyLossUsd: 500,
      dayPnl: 0,
      flattenFiredKey: null,
      liveRefused: true,
    });
    expect(result.actions[0]).toMatchObject({ kind: "refuse" });
  });

  it("does nothing when disabled", () => {
    const broker = new MockBroker();
    broker.injectOrder({ symbol: "MESU6", type: "Market", side: "Buy", qty: 1 });
    const result = planGateTick({
      now: PRINT,
      events,
      orders: broker.getOrdersSync(),
      positions: [],
      enabled: false,
      dailyLossUsd: 500,
      dayPnl: 0,
      flattenFiredKey: null,
      liveRefused: false,
    });
    expect(result.actions).toHaveLength(0);
  });
});

describe("GateEngine + MockBroker", () => {
  it("injecting a stop in-band gets cancelled", async () => {
    const broker = new MockBroker();
    broker.injectOrder({
      symbol: "MESU6",
      type: "StopMarket",
      side: "Sell",
      qty: 1,
      stopPrice: 5790,
    });
    const engine = new GateEngine(broker, () => PRINT, () => events, { enabled: true });
    await engine.tick();
    const working = broker.getOrdersSync().filter((o) => o.state === "Working");
    expect(working).toHaveLength(0);
    expect(broker.getOrdersSync()[0].state).toBe("Cancelled");
    expect(engine.getLogs().some((l) => l.message.includes("cancelled StopMarket MESU6"))).toBe(true);
  });

  it("flatten flats gated mock positions and leaves non-gated", async () => {
    const broker = new MockBroker();
    broker.injectPosition({ symbol: "MESU6", qty: 1, side: "Long", avgPrice: 5800 });
    broker.injectPosition({ symbol: "ZNU6", qty: 1, side: "Short", avgPrice: 111 });
    broker.injectPosition({ symbol: "CLU6", qty: 1, side: "Long", avgPrice: 70 });
    const engine = new GateEngine(broker, () => IDLE, () => events, { enabled: true });
    await engine.flattenSleeve("manual");
    const bySym = Object.fromEntries(broker.getPositionsSync().map((p) => [p.symbol, p]));
    expect(bySym.MESU6.side).toBe("Flat");
    expect(bySym.MESU6.qty).toBe(0);
    expect(bySym.ZNU6.side).toBe("Flat");
    expect(bySym.CLU6.side).toBe("Long");
    expect(bySym.CLU6.qty).toBe(1);
  });
});
