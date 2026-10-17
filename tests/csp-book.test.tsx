/**
 * @vitest-environment jsdom
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { CspBook } from "../client/src/CspBook";
import type { StatusSnapshot } from "../shared/types";

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

describe("CspBook", () => {
  it("does not show a T-bill interest line", () => {
    const status = {
      etradeAuth: "ok",
      csp: {
        equityUsd: 100_000,
        cashUsd: 80_000,
        reservedUsd: 20_000,
        utilizationPct: 20,
        realizedPnlUsd: 0,
        openPuts: [],
        assigned: [],
        skips: [],
        signals: [],
        recorder: { lastAt: null, rows: 0, blocking: false, auth: "ok" },
        shadow: [],
      },
    } as StatusSnapshot;
    const node = render(<CspBook status={status} />);
    expect(node.textContent).not.toContain("T-bill");
    expect(node.textContent).toContain("realized");
  });

  it("shows each queued candidate's month-end beta and as-of date", () => {
    const status = {
      etradeAuth: "ok",
      csp: {
        equityUsd: 100_000,
        cashUsd: 80_000,
        reservedUsd: 20_000,
        utilizationPct: 20,
        realizedPnlUsd: 0,
        openPuts: [],
        assigned: [],
        skips: [],
        signals: ["NVDA signal 2026-10-16 for 2026-10-19 beta 1.42 as of 2026-09-30"],
        queued: [{ symbol: "NVDA", tradeYmd: "2026-10-19", beta: 1.42, betaAsOfYmd: "2026-09-30" }],
        betaAsOfYmd: "2026-09-30",
        recorder: { lastAt: null, rows: 0, blocking: false, auth: "ok" },
        shadow: [],
      },
    } as StatusSnapshot;
    const node = render(<CspBook status={status} />);
    expect(node.textContent).toContain("Beta as of 2026-09-30");
    expect(node.textContent).toContain("NVDA beta 1.42 as of 2026-09-30");
  });
});
