import { describe, expect, it } from "vitest";
import {
  applySleevePatch,
  defaultSleeves,
  emptyPaperStats,
} from "../shared/types";

describe("defaultSleeves", () => {
  it("returns five thesis/risk cards with the expected defaults", () => {
    const sleeves = defaultSleeves();
    expect(Object.keys(sleeves).sort()).toEqual(
      ["day", "momentum", "options", "ownership", "riskoff"].sort(),
    );
    expect(sleeves.day.name).toBe("Day trading (events)");
    expect(sleeves.day.horizon).toBe("intraday");
    expect(sleeves.day.budgetPct).toBe(15);
    expect(sleeves.day.lossCapUsd).toBe(500);
    expect(sleeves.day.instruments).toMatch(/MES/);
    expect(sleeves.day.killRules).toMatch(/15:45/);
    expect(sleeves.day.status).toBe("paper");
    expect(sleeves.momentum.name).toBe("Short-term momentum");
    expect(sleeves.momentum.horizon).toBe("days–weeks");
    expect(sleeves.momentum.budgetPct).toBe(25);
    expect(sleeves.momentum.lossCapUsd).toBe(1000);
    expect(sleeves.momentum.status).toBe("idea");
    expect(sleeves.momentum.thesis).toBe("");
    expect(sleeves.options.name).toBe("Options (defined risk)");
    expect(sleeves.options.horizon).toBe("days–months");
    expect(sleeves.options.budgetPct).toBe(20);
    expect(sleeves.options.structure).toMatch(/no naked short vol/);
    expect(sleeves.options.status).toBe("idea");
    expect(sleeves.ownership.name).toBe("Longer-term ownership + overlay");
    expect(sleeves.ownership.horizon).toBe("months+");
    expect(sleeves.ownership.budgetPct).toBe(40);
    expect(sleeves.ownership.lossCapUsd).toBe(2000);
    expect(sleeves.ownership.structure).toMatch(/covered call/);
    expect(sleeves.ownership.killRules).toMatch(/not session clock/);
    expect(sleeves.ownership.status).toBe("idea");
    expect(sleeves.riskoff.name).toMatch(/Risk-off/);
    expect(sleeves.riskoff.status).toBe("paper");
    expect(sleeves.riskoff.thesis).toMatch(/RISK OFF/);
    expect(sleeves.riskoff.structure).toMatch(/put debit verticals only/);
    expect(sleeves.riskoff.structure).toMatch(/no naked short vol/);
    expect(sleeves.riskoff.killRules).toMatch(/max debit lost/);
    expect(sleeves.riskoff.instruments).toMatch(/SPY/);
    expect(sleeves.day.paper).toEqual(emptyPaperStats());
    expect(sleeves.riskoff.paper).toEqual(emptyPaperStats());
  });
});

describe("applySleevePatch", () => {
  it("merges the whitelist and does not invent buy/sell/EnterLong routes or fields", () => {
    const before = defaultSleeves().momentum;
    const patched = applySleevePatch(before, {
      thesis: "breakout after CPI",
      buy: true,
      sell: "Sell",
      EnterLong: { qty: 1 },
      flatten: true,
      route: "/api/buy",
      orders: [{ side: "Buy" }],
    } as Record<string, unknown>);
    expect(patched.thesis).toBe("breakout after CPI");
    expect(patched.id).toBe("momentum");
    expect(patched).not.toHaveProperty("buy");
    expect(patched).not.toHaveProperty("sell");
    expect(patched).not.toHaveProperty("EnterLong");
    expect(patched).not.toHaveProperty("flatten");
    expect(patched).not.toHaveProperty("route");
    expect(patched).not.toHaveProperty("orders");
    const json = JSON.stringify(patched);
    expect(json).not.toMatch(/EnterLong/);
    expect(json).not.toMatch(/\/api\/buy/);
    expect(json).not.toMatch(/"sell"/i);
  });

  it("merges paper stats without replacing omitted fields", () => {
    const before = defaultSleeves().options;
    before.paper = { trades: 4, wins: 2, losses: 2, realizedPnlUsd: -40, notes: "keep" };
    const patched = applySleevePatch(before, {
      paper: { trades: 5, realizedPnlUsd: -10 },
    } as Record<string, unknown>);
    expect(patched.paper).toEqual({
      trades: 5,
      wins: 2,
      losses: 2,
      realizedPnlUsd: -10,
      notes: "keep",
    });
  });
});
