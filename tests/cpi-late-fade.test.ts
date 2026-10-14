import { afterEach, describe, expect, it, vi } from "vitest";
import { seedEvents, zonedTimeToUtc } from "../shared/clock";
import { CPI_LATE_FADE_ENABLED } from "../shared/constants";
import type { CalendarEvent, Position } from "../shared/types";
import { planGateTick, GateEngine } from "../server/src/gate";
import { MockBroker } from "../server/src/mockBroker";
import { decideDayMomentum, type MinuteBar } from "../server/src/dayMomentum";
import {
  CPI_LATE_FADE_STOP_FRAC,
  cpiLateFadeSignal,
  cpiLateFadeStopPrice,
  decideCpiLateFade,
  mergeCpiLateFadeBars,
  noteCpiLateFadeSkip,
  previousWeekdayKey,
  resetCpiLateFadeSkipLog,
} from "../server/src/cpiLateFade";

const events = seedEvents();
const cpiDay = { y: 2026, m: 10, d: 14 };
const priorDay = { y: 2026, m: 10, d: 13 };

function at(day: { y: number; m: number; d: number }, hour: number, minute: number): Date {
  return zonedTimeToUtc(day.y, day.m, day.d, hour, minute, 0);
}

function bar(day: { y: number; m: number; d: number }, hour: number, minute: number, close: number): MinuteBar {
  return {
    ts: at(day, hour, minute).getTime(),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  };
}

/** Prior 15:55 close, today's 10:25 close, and a 15:25 bar so 15:30 is not stale. */
function fadeBars(priorClose: number, price1030: number, entry = price1030): MinuteBar[] {
  return [
    bar(priorDay, 15, 55, priorClose),
    bar(cpiDay, 10, 25, price1030),
    bar(cpiDay, 15, 25, entry),
  ];
}

function fadePos(side: Position["side"], avg = 5000): Position {
  return {
    id: "fade",
    symbol: "MES=F",
    root: "MES",
    qty: 1,
    side,
    avgPrice: avg,
    unrealizedPnl: 0,
    gated: true,
    sleeveId: "day",
    cpiLateFade: true,
  };
}

function stochPos(): Position {
  return {
    id: "stoch",
    symbol: "MES=F",
    root: "MES",
    qty: 1,
    side: "Long",
    avgPrice: 5000,
    unrealizedPnl: 0,
    gated: true,
    sleeveId: "day",
  };
}

const entryNow = at(cpiDay, 15, 30);
const knowledge = at(cpiDay, 8, 35).toISOString();

function decide(extra: Partial<Parameters<typeof decideCpiLateFade>[0]> = {}) {
  return decideCpiLateFade({
    now: entryNow,
    gateMode: "idle",
    bars: fadeBars(100, 101, 102),
    positions: [],
    sleeveLossCapUsd: 500,
    sleeveRealizedPnlUsd: 0,
    knowledgeTime: knowledge,
    events,
    ...extra,
  });
}

describe("CPI_LATE_FADE_ENABLED", () => {
  it("defaults on", () => {
    expect(CPI_LATE_FADE_ENABLED).toBe(true);
  });
});

describe("cpiLateFade signal and entry", () => {
  it("fades an up move short and a down move long, qty 1, tagged cpiLateFade", () => {
    const up = decide();
    expect(up.buy?.side).toBe("Sell");
    expect(up.buy?.qty).toBe(1);
    expect(up.buy?.symbol).toBe("MES=F");
    expect(up.buy?.sleeveId).toBe("day");
    expect(up.buy?.thesis.startsWith("cpiLateFade")).toBe(true);
    expect(up.buy?.stopPrice).toBeCloseTo(102 * (1 + CPI_LATE_FADE_STOP_FRAC), 8);

    const down = decide({ bars: fadeBars(100, 99, 98) });
    expect(down.buy?.side).toBe("Buy");
    expect(down.buy?.qty).toBe(1);
    expect(down.buy?.thesis.startsWith("cpiLateFade")).toBe(true);
    expect(down.buy?.stopPrice).toBeCloseTo(98 * (1 - CPI_LATE_FADE_STOP_FRAC), 8);
    expect(down.sells).toEqual([]);
  });

  it("does not trade a flat signal", () => {
    const got = decide({ bars: fadeBars(100, 100, 100) });
    expect(got.buy).toBeNull();
    expect(got.sells).toEqual([]);
    expect(got.reason).toBe("flat signal");
    expect(cpiLateFadeSignal(entryNow, fadeBars(100, 100, 100)).ok).toBe(false);
  });

  it("does not trade when the 10:30 bar or the prior close is missing", () => {
    const noPrint = decide({ bars: [bar(priorDay, 15, 55, 100), bar(cpiDay, 15, 25, 101)] });
    expect(noPrint.buy).toBeNull();
    expect(noPrint.reason).toBe("missing MES 5m 10:30");

    const noPrior = decide({ bars: [bar(cpiDay, 10, 25, 101), bar(cpiDay, 15, 25, 102)] });
    expect(noPrior.buy).toBeNull();
    expect(noPrior.reason).toBe("missing MES 5m prior close");
  });

  it("reproduces a Yahoo range=1d series that starts near midnight ET without the prior close", () => {
    const todayOnly = [
      bar(cpiDay, 0, 5, 100),
      bar(cpiDay, 10, 25, 110),
      bar(cpiDay, 15, 25, 111),
    ];
    const missing = cpiLateFadeSignal(entryNow, todayOnly);
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("missing MES 5m prior close");
    expect(decide({ bars: todayOnly }).reason).toBe("missing MES 5m prior close");

    const merged = mergeCpiLateFadeBars(todayOnly, [bar(priorDay, 15, 55, 100), ...todayOnly]);
    const got = cpiLateFadeSignal(entryNow, merged);
    expect(got.ok).toBe(true);
    if (got.ok) {
      expect(got.priorClose).toBe(100);
      expect(got.price1030).toBe(110);
      expect(got.moveSign).toBe(1);
    }
    expect(decide({ bars: merged }).buy?.side).toBe("Sell");
  });

  it("does not trade when the MES series is stale", () => {
    const got = decide({
      bars: [bar(priorDay, 15, 55, 100), bar(cpiDay, 10, 25, 101), bar(cpiDay, 11, 0, 101)],
    });
    expect(got.buy).toBeNull();
    expect(got.reason).toBe("stale MES 5m bars");
  });

  it("skips when the stochastic leg already holds MES", () => {
    const got = decide({ positions: [stochPos()] });
    expect(got.buy).toBeNull();
    expect(got.sells).toEqual([]);
    expect(got.reason).toBe("MES already held by stoch");
  });

  it("does not trade on an NFP day or an FOMC day", () => {
    const nfp = decide({
      now: at({ y: 2026, m: 10, d: 2 }, 15, 30),
      knowledgeTime: at({ y: 2026, m: 10, d: 2 }, 8, 35).toISOString(),
      bars: [
        bar({ y: 2026, m: 10, d: 1 }, 15, 55, 100),
        bar({ y: 2026, m: 10, d: 2 }, 10, 25, 110),
        bar({ y: 2026, m: 10, d: 2 }, 15, 25, 110),
      ],
    });
    expect(nfp.buy).toBeNull();
    expect(nfp.reason).toBe("not a CPI day");

    const fomc = decide({
      now: at({ y: 2026, m: 10, d: 28 }, 15, 30),
      knowledgeTime: at({ y: 2026, m: 10, d: 28 }, 14, 5).toISOString(),
    });
    expect(fomc.buy).toBeNull();
    expect(fomc.reason).toBe("not a CPI day");
  });

  it("does not trade a claims row or when the flag is off", () => {
    const claims: CalendarEvent = {
      id: "claims-2026-10-15",
      timeUtc: at({ y: 2026, m: 10, d: 15 }, 8, 30).toISOString(),
      type: "CLAIMS",
      flattenEt: "15:45",
    };
    const got = decide({
      now: at({ y: 2026, m: 10, d: 15 }, 15, 30),
      knowledgeTime: at({ y: 2026, m: 10, d: 15 }, 8, 35).toISOString(),
      events: [claims],
      bars: [
        bar({ y: 2026, m: 10, d: 14 }, 15, 55, 100),
        bar({ y: 2026, m: 10, d: 15 }, 10, 25, 110),
        bar({ y: 2026, m: 10, d: 15 }, 15, 25, 110),
      ],
    });
    expect(got.buy).toBeNull();
    expect(got.reason).toBe("not a CPI day");

    const off = decide({ enabled: false });
    expect(off.buy).toBeNull();
    expect(off.reason).toBe("cpiLateFade off");
  });

  it("does not enter without knowledge_time", () => {
    const got = decide({ knowledgeTime: null });
    expect(got.buy).toBeNull();
    expect(got.reason).toMatch(/knowledge_time/);
  });
});

describe("previous NYSE session", () => {
  it("uses the prior weekday on a normal CPI Wednesday", () => {
    expect(previousWeekdayKey(entryNow)).toBe("2026-10-13");
  });

  it("skips the weekend back to Friday", () => {
    expect(previousWeekdayKey(at({ y: 2026, m: 10, d: 12 }, 15, 30))).toBe("2026-10-09");
  });

  it("skips a full holiday and still counts an early-close session", () => {
    expect(previousWeekdayKey(at({ y: 2026, m: 9, d: 8 }, 15, 30))).toBe("2026-09-04");
    expect(previousWeekdayKey(at({ y: 2026, m: 1, d: 20 }, 15, 30))).toBe("2026-01-16");
    expect(previousWeekdayKey(at({ y: 2026, m: 11, d: 30 }, 15, 30))).toBe("2026-11-27");
  });

  it("reads the Friday close after Labor Day, not the holiday Monday", () => {
    const tue = at({ y: 2026, m: 9, d: 8 }, 15, 30);
    const bars = [
      bar({ y: 2026, m: 9, d: 4 }, 15, 55, 200),
      bar({ y: 2026, m: 9, d: 7 }, 15, 55, 50),
      bar({ y: 2026, m: 9, d: 8 }, 10, 25, 210),
      bar({ y: 2026, m: 9, d: 8 }, 15, 25, 211),
    ];
    const got = cpiLateFadeSignal(tue, bars);
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.priorClose).toBe(200);
  });
});

describe("cpiLateFade skip log", () => {
  afterEach(() => {
    resetCpiLateFadeSkipLog();
    vi.restoreAllMocks();
  });

  it("logs an entry-window skip once per ET day at info", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    noteCpiLateFadeSkip(entryNow, "missing MES 5m prior close");
    noteCpiLateFadeSkip(at(cpiDay, 15, 32), "missing MES 5m prior close");
    noteCpiLateFadeSkip(at(cpiDay, 11, 0), "missing MES 5m prior close");
    noteCpiLateFadeSkip(entryNow, "not a CPI day");
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("cpiLateFade skip"));
    expect(lines).toEqual(["[EventGate] cpiLateFade skip: missing MES 5m prior close"]);

    noteCpiLateFadeSkip(at({ y: 2026, m: 11, d: 10 }, 15, 30), "flat signal");
    const again = info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("cpiLateFade skip"));
    expect(again).toEqual([
      "[EventGate] cpiLateFade skip: missing MES 5m prior close",
      "[EventGate] cpiLateFade skip: flat signal",
    ]);
  });
});

describe("cpiLateFade exits", () => {
  it("flattens an open fade at 15:59 ET and does not hold it the next morning", () => {
    const atClose = decideCpiLateFade({
      now: at(cpiDay, 15, 59),
      gateMode: "idle",
      bars: fadeBars(100, 101, 102),
      positions: [fadePos("Short", 102)],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      knowledgeTime: knowledge,
      events,
    });
    expect(atClose.buy).toBeNull();
    expect(atClose.sells[0]?.reason).toMatch(/cpiLateFade/);
    expect(atClose.sells[0]?.reason).toMatch(/15:59/);

    const nextMorning = decideCpiLateFade({
      now: at({ y: 2026, m: 10, d: 15 }, 9, 40),
      gateMode: "idle",
      bars: [],
      positions: [fadePos("Short", 102)],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      events,
    });
    expect(nextMorning.sells[0]?.reason).toMatch(/cpiLateFade/);
    expect(nextMorning.buy).toBeNull();
  });

  it("stops a long 0.4% under the fill and a short 0.4% above it", () => {
    expect(cpiLateFadeStopPrice("Buy", 5000)).toBeCloseTo(5000 * (1 - CPI_LATE_FADE_STOP_FRAC), 8);
    expect(cpiLateFadeStopPrice("Sell", 5000)).toBeCloseTo(5000 * (1 + CPI_LATE_FADE_STOP_FRAC), 8);

    const longStop = decideCpiLateFade({
      now: at(cpiDay, 15, 40),
      gateMode: "SESSION FLATTEN",
      bars: [bar(cpiDay, 15, 35, 5000 * (1 - CPI_LATE_FADE_STOP_FRAC))],
      positions: [fadePos("Long", 5000)],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      events,
    });
    expect(longStop.reason).toBe("stop");
    expect(longStop.sells[0]?.reason).toBe("cpiLateFade stop 0.4%");

    const longHold = decideCpiLateFade({
      now: at(cpiDay, 15, 40),
      gateMode: "idle",
      bars: [bar(cpiDay, 15, 35, 5000 * (1 - CPI_LATE_FADE_STOP_FRAC) + 0.01)],
      positions: [fadePos("Long", 5000)],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      events,
    });
    expect(longHold.sells).toEqual([]);
    expect(longHold.reason).toBe("hold");

    const shortStop = decideCpiLateFade({
      now: at(cpiDay, 15, 40),
      gateMode: "idle",
      bars: [bar(cpiDay, 15, 35, 5000 * (1 + CPI_LATE_FADE_STOP_FRAC))],
      positions: [fadePos("Short", 5000)],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
      events,
    });
    expect(shortStop.reason).toBe("stop");
    expect(shortStop.sells[0]?.reason).toMatch(/cpiLateFade/);
  });

  it("does not let the stochastic decision flatten a fade lot at 15:45", () => {
    const got = decideDayMomentum({
      now: at(cpiDay, 15, 50),
      gateMode: "idle",
      bars: [],
      positions: [fadePos("Long")],
      sleeveLossCapUsd: 500,
      sleeveRealizedPnlUsd: 0,
    });
    expect(got.sells).toEqual([]);
    expect(got.buy).toBeNull();
  });
});

describe("GATE and the fade lot", () => {
  const sessionFlatten = at(cpiDay, 15, 45);

  it("does not session-flatten a cpiLateFade MES lot, and still flattens an untagged MES", () => {
    const broker = new MockBroker();
    broker.injectPosition({
      symbol: "MES=F",
      qty: 1,
      side: "Short",
      avgPrice: 5800,
      sleeveId: "day",
      cpiLateFade: true,
    });
    broker.injectOrder({
      symbol: "MES=F",
      type: "StopMarket",
      side: "Buy",
      qty: 1,
      stopPrice: 5823,
      sleeveId: "day",
    });
    const fadeOnly = planGateTick({
      now: sessionFlatten,
      events,
      orders: broker.getOrdersSync(),
      positions: broker.getPositionsSync(),
      enabled: true,
      dailyLossUsd: 500,
      dayPnl: 0,
      flattenFiredKey: null,
      liveRefused: false,
    });
    expect(fadeOnly.mode).toBe("SESSION FLATTEN");
    expect(fadeOnly.actions.some((a) => a.kind === "flatten")).toBe(false);

    const stoch = new MockBroker();
    stoch.injectPosition({ symbol: "MES=F", qty: 1, side: "Long", avgPrice: 5800, sleeveId: "day" });
    const stochTick = planGateTick({
      now: sessionFlatten,
      events,
      orders: [],
      positions: stoch.getPositionsSync(),
      enabled: true,
      dailyLossUsd: 500,
      dayPnl: 0,
      flattenFiredKey: null,
      liveRefused: false,
    });
    expect(stochTick.actions.some((a) => a.kind === "flatten" && a.symbol === "MES=F")).toBe(true);
  });

  it("still flattens the fade on daily loss and on manual Flatten", async () => {
    const broker = new MockBroker();
    broker.injectPosition({
      symbol: "MES=F",
      qty: 1,
      side: "Long",
      avgPrice: 5800,
      sleeveId: "day",
      cpiLateFade: true,
    });
    const loss = planGateTick({
      now: at(cpiDay, 15, 40),
      events,
      orders: [],
      positions: broker.getPositionsSync(),
      enabled: true,
      dailyLossUsd: 500,
      dayPnl: -500,
      flattenFiredKey: "2026-10-14",
      liveRefused: false,
    });
    expect(loss.actions.some((a) => a.kind === "flatten" && a.symbol === "MES=F")).toBe(true);

    const engine = new GateEngine(broker, () => at(cpiDay, 15, 40), () => events, { enabled: true });
    await engine.flattenSleeve("manual");
    expect(broker.getPositionsSync()[0]?.side).toBe("Flat");
  });
});
