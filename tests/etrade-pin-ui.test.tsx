/**
 * @vitest-environment jsdom
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { EtradePinBar } from "../client/src/EtradePin";

const AUTHORIZE_URL = "https://us.etrade.com/e/t/etws/authorize?key=ck-prod-TESTKEY&token=rt-prod-TESTTOKEN";
const PIN = "PIN1234";
const SECRET = "cs-prod-TESTSECRET";

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("EtradePinBar", () => {
  it("hides when E*TRADE is ok", () => {
    const node = render(
      <EtradePinBar
        auth="ok"
        onRefresh={() => {}}
        setAuthNeeded={() => {}}
        setErr={() => {}}
      />,
    );
    expect(node.textContent).toBe("");
    expect(node.querySelector(".etrade-pin")).toBeNull();
  });

  it("shows Authorize and a PIN field when needs_pin, without secrets in the DOM", () => {
    const node = render(
      <EtradePinBar
        auth="needs_pin"
        variant="essentials"
        onRefresh={() => {}}
        setAuthNeeded={() => {}}
        setErr={() => {}}
      />,
    );
    expect(node.textContent).toMatch(/E\*TRADE needs PIN/);
    expect(node.textContent).toMatch(/Authorize/);
    expect(node.querySelector("[aria-label=\"E*TRADE PIN\"]")).toBeTruthy();
    expect(node.textContent).not.toContain(SECRET);
    expect(node.textContent).not.toMatch(/us\.etrade\.com/);
    expect(node.innerHTML).not.toContain(AUTHORIZE_URL);
  });

  it("opens the authorize URL in a new tab and never paints it", async () => {
    const open = vi.fn(() => null);
    vi.stubGlobal("open", open);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toMatch(/\/api\/etrade\/oauth\/start$/);
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, authorizeUrl: AUTHORIZE_URL }),
        };
      }),
    );
    const node = render(
      <EtradePinBar
        auth="needs_pin"
        onRefresh={() => {}}
        setAuthNeeded={() => {}}
        setErr={() => {}}
      />,
    );
    await act(async () => {
      (node.querySelector(".etrade-pin-auth") as HTMLButtonElement).click();
    });
    expect(open).toHaveBeenCalledWith(AUTHORIZE_URL, "_blank", "noopener,noreferrer");
    expect(node.textContent).not.toMatch(/us\.etrade\.com/);
    expect(node.innerHTML).not.toContain("ck-prod-TESTKEY");
    expect(node.textContent).toMatch(/Open again/);
  });

  it("submits the PIN to /api/etrade/oauth/pin and does not echo it", async () => {
    const onRefresh = vi.fn();
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/api\/etrade\/oauth\/pin$/);
      const body = JSON.parse(String(init?.body ?? "{}")) as { pin?: string };
      expect(body.pin).toBe(PIN);
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    });
    vi.stubGlobal("fetch", fetchImpl);
    const node = render(
      <EtradePinBar
        auth="needs_pin"
        onRefresh={onRefresh}
        setAuthNeeded={() => {}}
        setErr={() => {}}
      />,
    );
    const input = node.querySelector("[aria-label=\"E*TRADE PIN\"]") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setter?.call(input, PIN);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (node.querySelector(".etrade-pin-form") as HTMLFormElement).requestSubmit();
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(node.textContent).not.toContain(PIN);
  });
});
