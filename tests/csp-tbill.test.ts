import { describe, expect, it } from "vitest";
import * as cspLive from "../server/src/cspLive";
import { reverseCspTbillAccrual } from "../server/src/cspTbillReversal";
import { collateralInvariant, sizeCashSecuredPut } from "../server/src/cspMath";
import { REDIS_KEYS } from "../shared/constants";

const STORED_INTEREST = 11.15;

function memoryRedis(seed: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(seed));
  return {
    store,
    async get(key: string) {
      return store.has(key) ? store.get(key)! : null;
    },
    async set(key: string, value: string) {
      store.set(key, value);
    },
  };
}

function sleeves(cspRealized: number, momentumRealized = 55) {
  return {
    csp: {
      id: "csp",
      paper: { trades: 2, wins: 1, losses: 1, realizedPnlUsd: cspRealized, notes: "keep" },
    },
    momentum: {
      id: "momentum",
      paper: { trades: 4, wins: 4, losses: 0, realizedPnlUsd: momentumRealized, notes: "mom" },
    },
  };
}

function cspState(accrued: number | null) {
  const state: Record<string, unknown> = {
    scannedAt: "2026-10-16T20:12:00.000Z",
    scannedYmd: "2026-10-16",
    pending: [
      {
        symbol: "CRH",
        signalYmd: "2026-10-16",
        tradeYmd: "2026-10-19",
        swingLow: 102.5,
        earnings: [],
        beta: 1.42,
      },
    ],
    ranked: [{ symbol: "CRH", beta: 1.42 }],
    recorderSlots: ["2026-10-16:close"],
  };
  if (accrued !== null) {
    state.tbillAccruedYmd = "2026-10-17";
    state.tbillAccruedUsd = accrued;
  }
  return state;
}

describe("csp T-bill reversal", () => {
  it("subtracts the stored cumulative once and leaves the CRH signal queued", async () => {
    const positions = [{ id: "pos-crh", symbol: "CRH", sleeveId: "csp", qty: 1 }];
    const redis = memoryRedis({
      [REDIS_KEYS.cspState]: JSON.stringify(cspState(STORED_INTEREST)),
      [REDIS_KEYS.sleeves]: JSON.stringify(sleeves(40 + STORED_INTEREST)),
      [REDIS_KEYS.mockPositions]: JSON.stringify(positions),
    });
    const logs: string[] = [];
    const first = await reverseCspTbillAccrual({ redis, log: (line) => logs.push(line) });
    expect(first.reversedUsd).toBe(STORED_INTEREST);
    expect(logs.some((line) => line.includes("reversed=11.15"))).toBe(true);

    const savedSleeves = JSON.parse(redis.store.get(REDIS_KEYS.sleeves) ?? "{}") as ReturnType<typeof sleeves>;
    expect(savedSleeves.csp.paper.realizedPnlUsd).toBe(40);
    expect(savedSleeves.csp.paper.notes).toBe("keep");
    expect(savedSleeves.momentum).toEqual(sleeves(0).momentum);
    const savedState = JSON.parse(redis.store.get(REDIS_KEYS.cspState) ?? "{}") as ReturnType<typeof cspState>;
    expect(savedState.pending).toEqual(cspState(null).pending);
    expect(savedState.pending[0]).toMatchObject({ symbol: "CRH", tradeYmd: "2026-10-19" });
    expect(savedState.ranked).toEqual(cspState(null).ranked);
    expect(savedState.recorderSlots).toEqual(["2026-10-16:close"]);
    expect(savedState.scannedAt).toBe("2026-10-16T20:12:00.000Z");
    expect(savedState).not.toHaveProperty("tbillAccruedUsd");
    expect(savedState).not.toHaveProperty("tbillAccruedYmd");
    expect(JSON.parse(redis.store.get(REDIS_KEYS.mockPositions) ?? "[]")).toEqual(positions);

    const equityAfter = 100_000 + savedSleeves.csp.paper.realizedPnlUsd;
    const reserved = 25_000;
    const assigned = 0;
    expect(collateralInvariant(reserved, assigned, equityAfter)).toBe(true);
    const sized = sizeCashSecuredPut({
      equityUsd: equityAfter,
      reservedUsd: reserved,
      assignedMvUsd: assigned,
      strike: 50,
      openPutCount: 1,
    });
    expect(sized.ok).toBe(true);
    if (sized.ok) expect(collateralInvariant(reserved + sized.reservedUsd, assigned, equityAfter)).toBe(true);
  });

  it("does not credit interest across a Friday, weekend, and Monday restart", async () => {
    expect("accrueCspTbill" in cspLive).toBe(false);
    const redis = memoryRedis({
      [REDIS_KEYS.cspState]: JSON.stringify(cspState(STORED_INTEREST)),
      [REDIS_KEYS.sleeves]: JSON.stringify(sleeves(STORED_INTEREST)),
    });
    const friday = await reverseCspTbillAccrual({ redis });
    expect(friday.reversedUsd).toBe(STORED_INTEREST);
    const saturday = await reverseCspTbillAccrual({ redis });
    const monday = await reverseCspTbillAccrual({ redis });
    expect(saturday.reversedUsd).toBe(0);
    expect(monday.reversedUsd).toBe(0);
    const saved = JSON.parse(redis.store.get(REDIS_KEYS.sleeves) ?? "{}") as ReturnType<typeof sleeves>;
    expect(saved.csp.paper.realizedPnlUsd).toBe(0);
    expect(saved.momentum.paper.realizedPnlUsd).toBe(55);
    const state = JSON.parse(redis.store.get(REDIS_KEYS.cspState) ?? "{}") as { pending: Array<{ symbol: string; tradeYmd: string }> };
    expect(state.pending[0]).toEqual({
      symbol: "CRH",
      signalYmd: "2026-10-16",
      tradeYmd: "2026-10-19",
      swingLow: 102.5,
      earnings: [],
      beta: 1.42,
    });
  });

  it("is idempotent when the accrual keys are already gone", async () => {
    const redis = memoryRedis({
      [REDIS_KEYS.cspState]: JSON.stringify(cspState(null)),
      [REDIS_KEYS.sleeves]: JSON.stringify(sleeves(12)),
    });
    const again = await reverseCspTbillAccrual({ redis });
    expect(again.reversedUsd).toBe(0);
    const saved = JSON.parse(redis.store.get(REDIS_KEYS.sleeves) ?? "{}") as ReturnType<typeof sleeves>;
    expect(saved.csp.paper.realizedPnlUsd).toBe(12);
    expect(saved.momentum.paper.realizedPnlUsd).toBe(55);
  });

  it("leaves the accrual keys in place when the csp sleeve card is missing", async () => {
    const redis = memoryRedis({
      [REDIS_KEYS.cspState]: JSON.stringify(cspState(STORED_INTEREST)),
    });
    const result = await reverseCspTbillAccrual({ redis });
    expect(result.reversedUsd).toBe(0);
    const state = JSON.parse(redis.store.get(REDIS_KEYS.cspState) ?? "{}") as { tbillAccruedUsd?: number; pending: unknown[] };
    expect(state.tbillAccruedUsd).toBe(STORED_INTEREST);
    expect(state.pending).toHaveLength(1);
  });
});
