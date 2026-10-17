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

describe("CspBook T-bill line", () => {
  it("shows accrued interest from the csp status payload", () => {
    const status = {
      etradeAuth: "ok",
      csp: {
        equityUsd: 100_010.96,
        cashUsd: 80_010.96,
        reservedUsd: 20_000,
        utilizationPct: 20,
        realizedPnlUsd: 10.96,
        tbillAccruedUsd: 10.96,
        openPuts: [],
        assigned: [],
        skips: [],
        signals: [],
        recorder: { lastAt: null, rows: 0, blocking: false, auth: "ok" },
        shadow: [],
      },
    } as StatusSnapshot;
    const node = render(<CspBook status={status} />);
    expect(node.textContent).toContain("T-bill");
    expect(node.textContent).toContain("+$10.96");
  });
});
