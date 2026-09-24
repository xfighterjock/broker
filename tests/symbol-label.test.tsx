/**
 * @vitest-environment jsdom
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SymbolLabel, SymbolList } from "../client/src/SymbolLabel";

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

describe("SymbolLabel", () => {
  it("shows the full name as the hover title for a known ticker", () => {
    const node = render(<SymbolLabel symbol="PDBC" />);
    const label = node.querySelector(".sym-tip");
    expect(label?.textContent).toBe("PDBC");
    expect(label?.getAttribute("title")).toBe(
      "Invesco Optimum Yield Diversified Commodity Strategy ETF",
    );
    expect(label?.getAttribute("aria-label")).toBe(
      "PDBC: Invesco Optimum Yield Diversified Commodity Strategy ETF",
    );
  });

  it("resolves a dated future to the futures root name", () => {
    const node = render(<SymbolLabel symbol="MESU6" />);
    expect(node.querySelector(".sym-tip")?.textContent).toBe("MESU6");
    expect(node.querySelector(".sym-tip")?.getAttribute("title")).toBe(
      "CME Micro E-mini S&P 500 futures",
    );
  });

  it("resolves an option package to the underlying name", () => {
    const node = render(<SymbolLabel symbol="GDX 40/38 P 2026-11-20" />);
    expect(node.querySelector(".sym-tip")?.getAttribute("title")).toBe("VanEck Gold Miners ETF");
  });

  it("leaves unknown symbols as the bare ticker with no tooltip", () => {
    const node = render(<SymbolLabel symbol="AAPL" />);
    const label = node.querySelector(".sym-tip");
    expect(label?.textContent).toBe("AAPL");
    expect(label?.hasAttribute("title")).toBe(false);
    expect(label?.hasAttribute("aria-label")).toBe(false);
  });

  it("gives each name in a symbol list its own description", () => {
    const node = render(<SymbolList symbols={["HYG", "GLD", "NOPE"]} />);
    const labels = [...node.querySelectorAll(".sym-tip")];
    expect(labels.map((el) => el.textContent)).toEqual(["HYG", "GLD", "NOPE"]);
    expect(labels[0]?.getAttribute("title")).toMatch(/High Yield Corporate Bond ETF/);
    expect(labels[1]?.getAttribute("title")).toBe("SPDR Gold Shares");
    expect(labels[2]?.hasAttribute("title")).toBe(false);
  });
});
