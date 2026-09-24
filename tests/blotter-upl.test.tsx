/**
 * @vitest-environment jsdom
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  BlotterOpenPositions,
  blotterOpenDayPnl,
  blotterOpenUnrealizedPnl,
  blotterPositionOnSleeve,
} from "../client/src/BlotterOpen";
import { PaperBlotter } from "../client/src/App";
import type { PaperFill, Position, SleeveId } from "../shared/types";

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(ui: ReactElement): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root!.render(ui);
  });
  return host;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = null;
  host = null;
});

function position(partial: Partial<Position> & Pick<Position, "id" | "symbol">): Position {
  return {
    root: null,
    qty: 1,
    side: "Long",
    avgPrice: 100,
    unrealizedPnl: 0,
    gated: false,
    ...partial,
  };
}

describe("blotter open unrealized P/L", () => {
  it("returns the stored mark for an open lot", () => {
    expect(
      blotterOpenUnrealizedPnl(position({ id: "a", symbol: "SPY", unrealizedPnl: 12.5 })),
    ).toBe(12.5);
    expect(
      blotterOpenUnrealizedPnl(
        position({ id: "b", symbol: "MES", side: "Short", unrealizedPnl: -8 }),
      ),
    ).toBe(-8);
    expect(
      blotterOpenUnrealizedPnl(position({ id: "c", symbol: "QQQ", unrealizedPnl: 0 })),
    ).toBe(0);
  });

  it("does not invent a P/L for flat, zero qty, or a non-finite mark", () => {
    expect(
      blotterOpenUnrealizedPnl(
        position({ id: "f", symbol: "SPY", side: "Flat", qty: 0, unrealizedPnl: 99 }),
      ),
    ).toBeNull();
    expect(
      blotterOpenUnrealizedPnl(
        position({ id: "z", symbol: "SPY", side: "Long", qty: 0, unrealizedPnl: 40 }),
      ),
    ).toBeNull();
    expect(
      blotterOpenUnrealizedPnl(
        position({ id: "n", symbol: "SPY", unrealizedPnl: Number.NaN }),
      ),
    ).toBeNull();
  });

  it("returns stored day P/L and does not copy unrealized when day is missing", () => {
    expect(
      blotterOpenDayPnl(position({ id: "a", symbol: "SPY", unrealizedPnl: 12.5, dayPnl: 3 })),
    ).toBe(3);
    expect(
      blotterOpenDayPnl(
        position({ id: "b", symbol: "MES", side: "Short", unrealizedPnl: -8, dayPnl: -2.5 }),
      ),
    ).toBe(-2.5);
    expect(blotterOpenDayPnl(position({ id: "z", symbol: "QQQ", unrealizedPnl: 40 }))).toBeNull();
    expect(
      blotterOpenDayPnl(
        position({ id: "n", symbol: "SPY", unrealizedPnl: 1, dayPnl: Number.NaN }),
      ),
    ).toBeNull();
    expect(
      blotterOpenDayPnl(
        position({ id: "f", symbol: "SPY", side: "Flat", qty: 0, dayPnl: 9 }),
      ),
    ).toBeNull();
    expect(
      blotterOpenDayPnl(
        position({ id: "q", symbol: "SPY", qty: 0, unrealizedPnl: 4, dayPnl: 4 }),
      ),
    ).toBeNull();
  });

  it("keeps untagged lots on the day sleeve only", () => {
    expect(blotterPositionOnSleeve("day", undefined)).toBe(true);
    expect(blotterPositionOnSleeve("momentum", undefined)).toBe(false);
    expect(blotterPositionOnSleeve("options", "options")).toBe(true);
    expect(blotterPositionOnSleeve("ownership", "options")).toBe(false);
    expect(blotterPositionOnSleeve("riskoff", "riskoff")).toBe(true);
  });
});

describe("BlotterOpenPositions", () => {
  const rows: Position[] = [
    position({
      id: "mes",
      symbol: "MESU6",
      root: "MES",
      sleeveId: "day",
      avgPrice: 5800,
      unrealizedPnl: 25,
      dayPnl: 10,
      gated: true,
    }),
    position({
      id: "spy",
      symbol: "SPY",
      sleeveId: "momentum",
      side: "Short",
      qty: 2,
      avgPrice: 500,
      unrealizedPnl: -8,
      dayPnl: 3,
    }),
    position({
      id: "flat",
      symbol: "IWM",
      sleeveId: "day",
      side: "Flat",
      qty: 0,
      unrealizedPnl: 99,
    }),
    position({
      id: "nan",
      symbol: "QQQ",
      sleeveId: "day",
      unrealizedPnl: Number.NaN,
    }),
    position({
      id: "untagged",
      symbol: "GLD",
      unrealizedPnl: 4,
      dayPnl: -1.5,
    }),
  ];

  function openTable(sleeveId: SleeveId): HTMLTableElement {
    const node = render(<BlotterOpenPositions sleeveId={sleeveId} positions={rows} />);
    const table = node.querySelector("table.blotter-open");
    expect(table).toBeTruthy();
    return table as HTMLTableElement;
  }

  it("shows signed dollars and color on each open sleeve row", () => {
    const table = openTable("day");
    const upl = Array.from(table.querySelectorAll(".blotter-upl")).map((el) => ({
      text: el.textContent,
      className: el.className,
    }));
    expect(upl).toEqual([
      { text: "+$25.00", className: "ok blotter-upl" },
      { text: "—", className: "muted blotter-upl" },
      { text: "+$4.00", className: "ok blotter-upl" },
    ]);
    const day = Array.from(table.querySelectorAll(".blotter-dpnl")).map((el) => ({
      text: el.textContent,
      className: el.className,
    }));
    expect(day).toEqual([
      { text: "+$10.00", className: "ok blotter-dpnl" },
      { text: "—", className: "muted blotter-dpnl" },
      { text: "-$1.50", className: "err blotter-dpnl" },
    ]);
    const headers = Array.from(table.querySelectorAll("th")).map((th) => th.textContent);
    expect(headers).toEqual(["Sym", "Side", "Qty", "Avg", "uPnL", "dPnL"]);
    expect(table.textContent).not.toContain("IWM");
    expect(table.textContent).not.toContain("99");
    expect(table.textContent).not.toContain("SPY");
    const mes = table.querySelector(".sym-tip");
    expect(mes?.textContent).toBe("MESU6");
    expect(mes?.getAttribute("title")).toBe("CME Micro E-mini S&P 500 futures");
  });

  it("shows a short loss on the momentum sleeve and hides other books", () => {
    const table = openTable("momentum");
    const cell = table.querySelector(".blotter-upl");
    expect(cell?.textContent).toBe("-$8.00");
    expect(cell?.className).toBe("err blotter-upl");
    const day = table.querySelector(".blotter-dpnl");
    expect(day?.textContent).toBe("+$3.00");
    expect(day?.className).toBe("ok blotter-dpnl");
    expect(table.textContent).not.toContain("MESU6");
    expect(table.textContent).not.toContain("GLD");
  });

  it("reads flat when the sleeve has no open qty", () => {
    const table = openTable("ownership");
    expect(table.textContent).toContain("flat");
    expect(table.querySelector(".blotter-upl")).toBeNull();
    expect(table.querySelector(".blotter-dpnl")).toBeNull();
  });

  it("prints a zero mark as $0.00 without a gain/loss color", () => {
    const node = render(
      <BlotterOpenPositions
        sleeveId="options"
        positions={[
          position({ id: "opt", symbol: "SPY", sleeveId: "options", unrealizedPnl: 0, dayPnl: 0 }),
        ]}
      />,
    );
    const cell = node.querySelector(".blotter-upl");
    expect(cell?.textContent).toBe("$0.00");
    expect(cell?.className).toBe("muted blotter-upl");
    const day = node.querySelector(".blotter-dpnl");
    expect(day?.textContent).toBe("$0.00");
    expect(day?.className).toBe("muted blotter-dpnl");
  });
});

describe("PaperBlotter fill journal", () => {
  it("keeps closed fills free of an unrealized column", () => {
    const fill: PaperFill = {
      id: "fill-1",
      sleeveId: "day",
      ts: "2026-09-24T14:30:00.000Z",
      symbol: "MES",
      side: "Sell",
      qty: 1,
      price: 5810,
      notes: "stop hit",
    };
    const node = render(
      <PaperBlotter
        sleeveId="day"
        fills={[fill]}
        positions={[
          position({
            id: "open",
            symbol: "MESU6",
            root: "MES",
            sleeveId: "day",
            unrealizedPnl: 15,
            dayPnl: 6,
            gated: true,
          }),
        ]}
        quotes={[]}
        apply={() => {}}
        setAuthNeeded={() => {}}
        setErr={() => {}}
      />,
    );
    const fills = node.querySelector("table.blotter-fills");
    expect(fills).toBeTruthy();
    const headers = Array.from(fills!.querySelectorAll("th")).map((th) => th.textContent);
    expect(headers).toEqual(["Ts", "Sym", "Side", "Qty", "Px", "Notes", ""]);
    expect(fills!.textContent).toContain("stop hit");
    expect(fills!.querySelector(".blotter-upl")).toBeNull();
    expect(fills!.querySelector(".blotter-dpnl")).toBeNull();
    expect(fills!.textContent).not.toContain("+$15.00");
    expect(fills!.textContent).not.toContain("+$6.00");
    const openCell = node.querySelector("table.blotter-open .blotter-upl");
    expect(openCell?.textContent).toBe("+$15.00");
    const openDay = node.querySelector("table.blotter-open .blotter-dpnl");
    expect(openDay?.textContent).toBe("+$6.00");
    expect(openDay?.className).toBe("ok blotter-dpnl");
    expect(node.querySelector("table.blotter-open .sym-tip")?.getAttribute("title")).toBe(
      "CME Micro E-mini S&P 500 futures",
    );
  });
});
