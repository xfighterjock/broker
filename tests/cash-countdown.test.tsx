/**
 * @vitest-environment jsdom
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { zonedTimeToUtc } from "../shared/clock";
import { computeMarketSession } from "../shared/marketSession";
import { CashCountdown } from "../client/src/CashCountdown";

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
  vi.useRealTimers();
});

describe("CashCountdown", () => {
  it("ticks once a second toward the server close without another request", () => {
    vi.useFakeTimers();
    const at = zonedTimeToUtc(2026, 9, 8, 10, 0, 0);
    vi.setSystemTime(at);
    const session = computeMarketSession(at);
    const node = render(<CashCountdown session={session} />);
    expect(node.querySelector(".cash-cd")?.textContent).toBe("Cash close in 6h 0m 00s");
    expect(node.querySelector(".cash-cd")?.getAttribute("title")).toMatch(/16:00:00 EDT/);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(node.querySelector(".cash-cd")?.textContent).toBe("Cash close in 5h 59m 59s");
  });

  it("labels a pre-open countdown to the server open, including an early close", () => {
    vi.useFakeTimers();
    const pre = zonedTimeToUtc(2026, 9, 8, 8, 0, 0);
    vi.setSystemTime(pre);
    const node = render(<CashCountdown session={computeMarketSession(pre)} />);
    expect(node.querySelector(".cash-cd")?.textContent).toBe("Cash open in 1h 30m 00s");

    const early = zonedTimeToUtc(2026, 11, 27, 12, 30, 0);
    vi.setSystemTime(early);
    const earlyNode = render(<CashCountdown session={computeMarketSession(early)} />);
    expect(earlyNode.querySelector(".cash-cd")?.textContent).toBe("Cash close in 30m 00s");
    expect(earlyNode.querySelector(".cash-cd")?.getAttribute("title")).toMatch(/13:00:00 EST/);
  });

  it("renders nothing when both server instants are already past", () => {
    vi.useFakeTimers();
    vi.setSystemTime(zonedTimeToUtc(2026, 9, 10, 12, 0, 0));
    const stale = computeMarketSession(zonedTimeToUtc(2026, 9, 8, 10, 0, 0));
    const node = render(<CashCountdown session={stale} />);
    expect(node.querySelector(".cash-cd")).toBeNull();
  });
});
