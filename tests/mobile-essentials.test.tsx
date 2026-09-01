/**
 * @vitest-environment jsdom
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  defaultSleeves,
  emptyChecklist,
  emptyFreeze,
  type SleeveBook,
  type SleeveId,
  type StatusSnapshot,
} from "../shared/types";
import { FLATTEN_CONFIRM } from "../client/src/essentials";
import { MobileEssentials } from "../client/src/MobileEssentials";

function book(daily: number, total: number): SleeveBook {
  return {
    equityUsd: 100_000 + total,
    realizedPnlUsd: total,
    unrealizedPnlUsd: 0,
    pnlUsd: total,
    totalPnlUsd: total,
    dailyPnlUsd: daily,
  };
}

function snapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    trader: "Richard",
    tz: "America/New_York",
    clock: {
      nowUtc: "2026-09-01T17:32:01.000Z",
      nowEt: "13:32:01",
      mode: "PRE-ARM",
      banner: true,
      nextEvent: null,
      activeEvent: null,
      focusEvent: {
        id: "nfp",
        timeUtc: "2026-09-04T12:30:00.000Z",
        type: "NFP",
        flattenEt: "15:45",
      },
      countdownMs: 90_000,
      countdownLabel: "T-1:30",
      flattenEt: "15:45",
      inPreArm: true,
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
    sleeveBooks: {
      day: book(12.5, -3),
      momentum: book(0, 0),
      options: book(40, 40),
      ownership: book(0, 0),
      riskoff: book(-8, -8),
    } as Record<SleeveId, SleeveBook>,
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

const mounted: { root: Root; node: HTMLDivElement }[] = [];

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function render(ui: ReactElement) {
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node);
  act(() => {
    root.render(ui);
  });
  mounted.push({ root, node });
  return node;
}

afterEach(() => {
  while (mounted.length) {
    const { root, node } = mounted.pop()!;
    act(() => {
      root.unmount();
    });
    node.remove();
  }
  vi.restoreAllMocks();
});

describe("MobileEssentials", () => {
  it("renders summary, large risk badge, and all five sleeve P/L rows", () => {
    const node = render(
      <MobileEssentials
        state={snapshot()}
        onToggleGate={() => {}}
        onToggleAutoPaper={() => {}}
        onFlatten={() => {}}
      />,
    );
    expect(node.textContent).toMatch(/EVENT GATE/);
    expect(node.textContent).toMatch(/PAPER · MOCK/);
    expect(node.textContent).toMatch(/13:32:01/);
    expect(node.textContent).toMatch(/PRE-ARM/);
    expect(node.textContent).toMatch(/NFP/);
    expect(node.textContent).toMatch(/RISK ON/);
    expect(node.textContent).toMatch(/SPY\/ACWI\/HYG above 200dma/);
    expect(node.textContent).toMatch(/GATE ON/);
    expect(node.textContent).toMatch(/AUTO PAPER ON/);
    expect(node.textContent).toMatch(/Flatten/);
    expect(node.querySelector("[data-sleeve=day]")?.textContent).toMatch(/d \+\$12\.50/);
    expect(node.querySelector("[data-sleeve=day]")?.textContent).toMatch(/tot -\$3\.00/);
    expect(node.querySelector("[data-sleeve=momentum]")?.textContent).toMatch(/Momentum/);
    expect(node.querySelector("[data-sleeve=options]")?.textContent).toMatch(/tot \+\$40\.00/);
    expect(node.querySelector("[data-sleeve=ownership]")?.textContent).toMatch(/Ownership/);
    expect(node.querySelector("[data-sleeve=riskoff]")?.textContent).toMatch(/d -\$8\.00/);
    expect(node.querySelector(".essentials-risk-badge")?.textContent).toBe("RISK ON");
    expect(node.querySelector(".grid")).toBeNull();
    expect(node.querySelector(".tabs")).toBeNull();
  });

  it("shows RISK OFF in red copy when the snapshot is off", () => {
    const node = render(
      <MobileEssentials
        state={snapshot({
          riskOn: false,
          riskChecks: {
            spyAbove200: false,
            acwiAbove200: true,
            hygAbove200: true,
            uup20dPct: 0.01,
            dollarVeto: false,
          },
        })}
        onToggleGate={() => {}}
        onToggleAutoPaper={() => {}}
        onFlatten={() => {}}
      />,
    );
    expect(node.querySelector(".essentials-risk-badge")?.textContent).toBe("RISK OFF");
    expect(node.querySelector(".essentials-risk")?.className).toMatch(/risk-off/);
    expect(node.textContent).toMatch(/SPY below 200dma/);
  });

  it("wires GATE and AUTO PAPER to the same handlers the desktop uses", () => {
    const onToggleGate = vi.fn();
    const onToggleAutoPaper = vi.fn();
    const node = render(
      <MobileEssentials
        state={snapshot({ gateEnabled: false, autoPaper: false })}
        onToggleGate={onToggleGate}
        onToggleAutoPaper={onToggleAutoPaper}
        onFlatten={() => {}}
      />,
    );
    expect(node.textContent).toMatch(/GATE OFF/);
    expect(node.textContent).toMatch(/AUTO PAPER OFF/);
    const toggles = node.querySelectorAll(".essentials-toggle");
    act(() => {
      (toggles[0] as HTMLLabelElement).click();
    });
    act(() => {
      (toggles[1] as HTMLLabelElement).click();
    });
    expect(onToggleGate).toHaveBeenCalledTimes(1);
    expect(onToggleAutoPaper).toHaveBeenCalledTimes(1);
  });

  it("confirms before Flatten and skips the handler on cancel", () => {
    const onFlatten = vi.fn();
    const node = render(
      <MobileEssentials
        state={snapshot()}
        onToggleGate={() => {}}
        onToggleAutoPaper={() => {}}
        onFlatten={onFlatten}
      />,
    );
    const btn = node.querySelector(".essentials-flatten") as HTMLButtonElement;
    vi.spyOn(window, "confirm").mockReturnValueOnce(false);
    act(() => {
      btn.click();
    });
    expect(window.confirm).toHaveBeenCalledWith(FLATTEN_CONFIRM);
    expect(onFlatten).not.toHaveBeenCalled();
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    act(() => {
      btn.click();
    });
    expect(onFlatten).toHaveBeenCalledTimes(1);
  });
});
