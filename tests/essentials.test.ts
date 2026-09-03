import { describe, expect, it } from "vitest";
import {
  defaultAutoPaperBySleeve,
  defaultSleeves,
  emptyChecklist,
  emptyFreeze,
  type Position,
  type SleeveBook,
  type SleeveId,
  type StatusSnapshot,
} from "../shared/types";
import {
  AUTO_SLEEVE_CHIPS,
  autoPaperAnyOn,
  autoPaperFlags,
  ESSENTIALS_MAX_WIDTH_PX,
  essentialsViewActive,
  formatPnlPct,
  formatPnlUsd,
  gateModeClass,
  pathWantsEssentials,
  riskBadgeTitle,
  riskWhyLine,
  sleeveOpenHint,
  sleevePnlRows,
} from "../client/src/essentials";

function book(daily: number, total: number, equity = 100_000 + total): SleeveBook {
  return {
    equityUsd: equity,
    realizedPnlUsd: total,
    unrealizedPnlUsd: 0,
    pnlUsd: total,
    totalPnlUsd: total,
    dailyPnlUsd: daily,
  };
}

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  const sleeveBooks = {
    day: book(12.5, -3),
    momentum: book(0, 0),
    options: book(40, 40),
    ownership: book(0, 0),
    riskoff: book(-8, -8),
  } as Record<SleeveId, SleeveBook>;
  return {
    trader: "Richard",
    tz: "America/New_York",
    clock: {
      nowUtc: "2026-09-01T17:32:01.000Z",
      nowEt: "13:32:01",
      mode: "idle",
      banner: false,
      nextEvent: null,
      activeEvent: null,
      focusEvent: null,
      countdownMs: null,
      countdownLabel: "",
      flattenEt: "15:45",
      inPreArm: false,
      inBand: false,
      inSessionFlatten: false,
    },
    events: [],
    freeze: emptyFreeze(),
    knowledgeTime: null,
    checklist: emptyChecklist(),
    sessionLog: [],
    actionLog: [],
    gateEnabled: true,
    dailyLossUsd: 500,
    qtyCap: 1,
    gatedRoots: ["MES"],
    authRequired: false,
    etradeAuth: "ok",
    broker: {
      name: "MockBroker",
      mode: "mock",
      liveRefused: false,
      stubNote: null,
      orders: [],
      positions: [],
      dayPnl: 0,
      account: "SIM",
    },
    sleeves: defaultSleeves(),
    activeSleeve: "day",
    paperBlotter: [],
    autoPaper: true,
    autoPaperBySleeve: defaultAutoPaperBySleeve(true),
    sleeveBooks,
    riskOn: true,
    riskChecks: {
      spyAbove200: true,
      acwiAbove200: true,
      hygAbove200: true,
      uup20dPct: 0.012,
      dollarVeto: false,
    },
    ...over,
  };
}

describe("essentials view selection", () => {
  it("uses /m even on a wide viewport", () => {
    expect(pathWantsEssentials("/m")).toBe(true);
    expect(pathWantsEssentials("/m/")).toBe(true);
    expect(essentialsViewActive("/m", false)).toBe(true);
  });

  it("uses a narrow viewport on /", () => {
    expect(pathWantsEssentials("/")).toBe(false);
    expect(essentialsViewActive("/", true)).toBe(true);
    expect(essentialsViewActive("/", false)).toBe(false);
  });

  it("does not treat unrelated paths as mobile", () => {
    expect(pathWantsEssentials("/mobile")).toBe(false);
    expect(pathWantsEssentials("/api/status")).toBe(false);
    expect(ESSENTIALS_MAX_WIDTH_PX).toBe(767);
  });
});

describe("gate mode + P/L formatters (same numbers as desktop tabs)", () => {
  it("maps gate modes to the desktop badge classes", () => {
    expect(gateModeClass("idle")).toBe("idle");
    expect(gateModeClass("PRE-ARM")).toBe("pre");
    expect(gateModeClass("NO-STOP BAND")).toBe("band");
    expect(gateModeClass("SESSION FLATTEN")).toBe("flat");
  });

  it("formats signed USD and percent the way sleeve tabs do", () => {
    expect(formatPnlUsd(12.5)).toBe("+$12.50");
    expect(formatPnlUsd(-8)).toBe("-$8.00");
    expect(formatPnlUsd(0)).toBe("$0.00");
    expect(formatPnlPct(40, 100_040)).toBe("+0.04%");
  });
});

describe("risk why line", () => {
  it("is a one-line ON reason without the day-book footnote", () => {
    const line = riskWhyLine(snapshot());
    expect(line).toMatch(/SPY\/ACWI\/HYG above 200dma/);
    expect(line).toMatch(/UUP 20d 1\.2%/);
    expect(line).not.toMatch(/day book/);
    expect(riskBadgeTitle(snapshot())).toMatch(/Does not bind the day book/);
  });

  it("lists failed checks when RISK OFF", () => {
    const s = snapshot({
      riskOn: false,
      riskChecks: {
        spyAbove200: false,
        acwiAbove200: true,
        hygAbove200: false,
        uup20dPct: 0.05,
        dollarVeto: true,
      },
    });
    const line = riskWhyLine(s);
    expect(line).toMatch(/SPY below 200dma/);
    expect(line).toMatch(/HYG below 200dma/);
    expect(line).toMatch(/dollar veto/);
    expect(line).not.toMatch(/ACWI below/);
  });
});

describe("AUTO PAPER flags", () => {
  it("exposes D/M/O/Ow/R chips for all five sleeves", () => {
    expect(AUTO_SLEEVE_CHIPS.map((c) => c.id)).toEqual([
      "day",
      "momentum",
      "options",
      "ownership",
      "riskoff",
    ]);
    expect(AUTO_SLEEVE_CHIPS.map((c) => c.initial)).toEqual(["D", "M", "O", "Ow", "R"]);
  });

  it("treats autoPaper as any-on and falls back when per-sleeve is missing", () => {
    const mixed = snapshot({
      autoPaper: true,
      autoPaperBySleeve: {
        day: false,
        momentum: true,
        options: false,
        ownership: false,
        riskoff: true,
      },
    });
    expect(autoPaperAnyOn(mixed)).toBe(true);
    expect(autoPaperFlags(mixed).day).toBe(false);
    expect(autoPaperFlags(mixed).riskoff).toBe(true);
    const legacyOn = snapshot({ autoPaper: true });
    delete (legacyOn as { autoPaperBySleeve?: unknown }).autoPaperBySleeve;
    expect(autoPaperFlags(legacyOn).day).toBe(true);
    const legacyOff = snapshot({ autoPaper: false });
    delete (legacyOff as { autoPaperBySleeve?: unknown }).autoPaperBySleeve;
    expect(autoPaperAnyOn(legacyOff)).toBe(false);
  });
});

describe("sleeve P/L rows", () => {
  it("emits all five sleeves with daily and total from the snapshot books", () => {
    const rows = sleevePnlRows(snapshot().sleeveBooks);
    expect(rows.map((r) => r.id)).toEqual([
      "day",
      "momentum",
      "options",
      "ownership",
      "riskoff",
    ]);
    expect(rows[0]).toMatchObject({ label: "Day", daily: 12.5, total: -3 });
    expect(rows[2]).toMatchObject({ label: "Options", daily: 40, total: 40 });
    expect(rows[4]).toMatchObject({ label: "Risk-off", daily: -8, total: -8 });
  });

  it("adds an open-lots hint from existing positions, not new P/L math", () => {
    const positions: Position[] = [
      {
        id: "1",
        symbol: "SPY",
        root: null,
        qty: 2,
        side: "Long",
        avgPrice: 500,
        unrealizedPnl: 10,
        gated: false,
        sleeveId: "momentum",
      },
    ];
    expect(sleeveOpenHint("momentum", positions)).toBe("1 open · 2 lots");
    expect(sleeveOpenHint("day", positions)).toBeNull();
    expect(sleevePnlRows(snapshot().sleeveBooks, positions)[1].hint).toBe("1 open · 2 lots");
  });
});
