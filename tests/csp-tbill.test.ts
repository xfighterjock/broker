import { beforeEach, describe, expect, it } from "vitest";
import { REDIS_KEYS } from "../shared/constants";
import {
  accrueCspTbill,
  cspTbillAccruedForStatus,
  cspTbillAccruedUsd,
  cspTbillRate,
  resetCspLiveForTests,
  resetCspTbillAccrual,
} from "../server/src/cspLive";
import {
  CSP_BS_RATE_FALLBACK,
  collateralInvariant,
  roundUsd,
  sizeCashSecuredPut,
  tbillAccrualCredit,
  tbillAccrualDays,
  tbillDayAccrual,
} from "../server/src/cspMath";

const FRIDAY = new Date("2026-10-16T20:12:00Z");
const SATURDAY = new Date("2026-10-17T16:00:00Z");
const MONDAY = new Date("2026-10-19T14:00:00Z");

function memoryRedis() {
  const store = new Map<string, string>();
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

beforeEach(() => {
  resetCspLiveForTests();
});

describe("csp T-bill accrual", () => {
  it("credits one calendar day and does not credit that day again", async () => {
    const redis = memoryRedis();
    const first = await accrueCspTbill({
      now: FRIDAY,
      equityUsd: 100_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      rate: 0.04,
      redis,
      log: () => {},
    });
    const second = await accrueCspTbill({
      now: FRIDAY,
      equityUsd: 100_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      rate: 0.04,
      redis,
      log: () => {},
    });
    expect(first.days).toBe(1);
    expect(first.credited).toBe(roundUsd(tbillDayAccrual(100_000, 0.04)));
    expect(first.credited).toBe(10.96);
    expect(second.credited).toBe(0);
    expect(second.days).toBe(0);
    expect(second.accruedUsd).toBe(first.accruedUsd);
    expect(cspTbillAccruedUsd()).toBe(first.accruedUsd);
    const saved = JSON.parse(redis.store.get(REDIS_KEYS.cspState) ?? "{}") as {
      tbillAccruedYmd: string;
      tbillAccruedUsd: number;
    };
    expect(saved.tbillAccruedYmd).toBe("2026-10-16");
    expect(saved.tbillAccruedUsd).toBe(first.accruedUsd);
  });

  it("reloads the last date from Redis after a restart and does not double-count", async () => {
    const redis = memoryRedis();
    const first = await accrueCspTbill({
      now: FRIDAY,
      equityUsd: 100_000,
      reservedUsd: 20_000,
      assignedMvUsd: 0,
      rate: 0.04,
      redis,
      log: () => {},
    });
    resetCspLiveForTests();
    expect(cspTbillAccruedUsd()).toBe(0);
    const again = await accrueCspTbill({
      now: FRIDAY,
      equityUsd: 100_000,
      reservedUsd: 20_000,
      assignedMvUsd: 0,
      rate: 0.04,
      redis,
      log: () => {},
    });
    expect(again.credited).toBe(0);
    expect(again.accruedUsd).toBe(first.accruedUsd);
    expect(await cspTbillAccruedForStatus(redis)).toBe(first.accruedUsd);
  });

  it("uses the 0.04 fallback when the rate is missing and still counts a weekend", async () => {
    const redis = memoryRedis();
    await accrueCspTbill({
      now: FRIDAY,
      equityUsd: 100_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      rate: 0.04,
      redis,
      log: () => {},
    });
    const saturday = await accrueCspTbill({
      now: SATURDAY,
      equityUsd: 100_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      rate: null,
      redis,
      log: () => {},
    });
    expect(saturday.days).toBe(1);
    expect(saturday.rate).toBe(CSP_BS_RATE_FALLBACK);
    expect(saturday.credited).toBe(roundUsd(tbillDayAccrual(100_000, CSP_BS_RATE_FALLBACK)));
    expect(await cspTbillRate()).toBe(CSP_BS_RATE_FALLBACK);
    const planned = tbillAccrualCredit({
      equityUsd: 100_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      annualRate: null,
      lastYmd: null,
      todayYmd: "2026-11-26",
    });
    expect(planned.rate).toBe(0.04);
    expect(tbillAccrualDays("2026-11-25", "2026-11-26")).toBe(1);
  });

  it("catches up each missed calendar day, including the weekend, in one credit", async () => {
    const redis = memoryRedis();
    await accrueCspTbill({
      now: FRIDAY,
      equityUsd: 100_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      rate: 0.04,
      redis,
      log: () => {},
    });
    const monday = await accrueCspTbill({
      now: MONDAY,
      equityUsd: 100_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      rate: 0.04,
      redis,
      log: () => {},
    });
    expect(monday.days).toBe(3);
    expect(monday.credited).toBe(roundUsd(tbillDayAccrual(100_000, 0.04) * 3));
    expect(monday.ymd).toBe("2026-10-19");
  });

  it("adds interest to equity without raising reserved collateral", async () => {
    const reserved = 25_000;
    const assigned = 10_000;
    const equity = 100_000;
    const redis = memoryRedis();
    const credit = await accrueCspTbill({
      now: FRIDAY,
      equityUsd: equity,
      reservedUsd: reserved,
      assignedMvUsd: assigned,
      rate: 0.05,
      redis,
      log: () => {},
    });
    const base = 100_000 - assigned;
    expect(credit.credited).toBe(roundUsd(tbillDayAccrual(base, 0.05)));
    const nextEquity = equity + credit.credited;
    expect(collateralInvariant(reserved, assigned, nextEquity)).toBe(true);
    expect(reserved + assigned).toBeLessThanOrEqual(nextEquity);
    const sized = sizeCashSecuredPut({
      equityUsd: nextEquity,
      reservedUsd: reserved,
      assignedMvUsd: assigned,
      strike: 50,
      openPutCount: 1,
    });
    expect(sized.ok).toBe(true);
    if (sized.ok) {
      expect(collateralInvariant(reserved + sized.reservedUsd, assigned, nextEquity)).toBe(true);
    }
  });

  it("clears only the csp interest total on a sleeve reset", async () => {
    const redis = memoryRedis();
    await accrueCspTbill({
      now: FRIDAY,
      equityUsd: 100_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      rate: 0.04,
      redis,
      log: () => {},
    });
    await resetCspTbillAccrual(redis);
    expect(cspTbillAccruedUsd()).toBe(0);
    const saved = JSON.parse(redis.store.get(REDIS_KEYS.cspState) ?? "{}") as {
      tbillAccruedYmd: string | null;
      tbillAccruedUsd: number;
    };
    expect(saved.tbillAccruedYmd).toBeNull();
    expect(saved.tbillAccruedUsd).toBe(0);
    const fresh = await accrueCspTbill({
      now: FRIDAY,
      equityUsd: 100_000,
      reservedUsd: 0,
      assignedMvUsd: 0,
      rate: 0.04,
      redis,
      log: () => {},
    });
    expect(fresh.credited).toBe(10.96);
  });
});
