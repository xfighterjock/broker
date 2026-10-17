/**
 * One-time paper reversal of T-bill interest that was credited to the csp sleeve.
 * Reads the stored cumulative from Redis. Does not accrue. No orders.
 */

import { REDIS_KEYS } from "../../shared/constants";

type LogFn = (line: string) => void;

type Multi = {
  set(key: string, value: string): Multi;
  exec(): Promise<unknown>;
};

export type TbillReversalRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  multi?: () => Multi;
};

export interface TbillReversalResult {
  reversedUsd: number;
}

/**
 * Subtract `tbillAccruedUsd` from the csp sleeve's realized P/L, then delete
 * `tbillAccruedUsd` and `tbillAccruedYmd`. A second call reverses 0.
 * Queued signals, ranks, recorder slots, other sleeves, and positions are not modified.
 * The sleeve card is left untouched when it is missing, and the accrual keys stay so
 * a later boot can still reverse them.
 */
export async function reverseCspTbillAccrual(deps: {
  redis: TbillReversalRedis | null;
  log?: LogFn;
}): Promise<TbillReversalResult> {
  const log = deps.log ?? (() => {});
  if (!deps.redis) {
    log("[EventGate] csp tbill reversal reversed=0 (no redis)");
    return { reversedUsd: 0 };
  }
  const redis = deps.redis;
  let rawState: string | null;
  try {
    rawState = await redis.get(REDIS_KEYS.cspState);
  } catch (err) {
    log(`[EventGate] csp tbill reversal reversed=0 (state read failed: ${message(err)})`);
    return { reversedUsd: 0 };
  }
  if (!rawState) {
    log("[EventGate] csp tbill reversal reversed=0");
    return { reversedUsd: 0 };
  }
  let state: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawState) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log("[EventGate] csp tbill reversal reversed=0 (state not an object; left untouched)");
      return { reversedUsd: 0 };
    }
    state = parsed as Record<string, unknown>;
  } catch {
    log("[EventGate] csp tbill reversal reversed=0 (state JSON invalid; left untouched)");
    return { reversedUsd: 0 };
  }

  const amount = positiveUsd(state.tbillAccruedUsd);
  const hasKeys = "tbillAccruedUsd" in state || "tbillAccruedYmd" in state;
  if (amount === 0) {
    if (hasKeys) {
      delete state.tbillAccruedUsd;
      delete state.tbillAccruedYmd;
      await redis.set(REDIS_KEYS.cspState, JSON.stringify(state));
    }
    log("[EventGate] csp tbill reversal reversed=0");
    return { reversedUsd: 0 };
  }

  let rawSleeves: string | null;
  try {
    rawSleeves = await redis.get(REDIS_KEYS.sleeves);
  } catch (err) {
    log(`[EventGate] csp tbill reversal skipped: sleeves read failed (${message(err)}); accrual keys left in place`);
    return { reversedUsd: 0 };
  }
  if (!rawSleeves) {
    log("[EventGate] csp tbill reversal skipped: csp sleeve card missing; accrual keys left in place");
    return { reversedUsd: 0 };
  }
  let sleeves: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawSleeves) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log("[EventGate] csp tbill reversal skipped: sleeves JSON invalid; accrual keys left in place");
      return { reversedUsd: 0 };
    }
    sleeves = parsed as Record<string, unknown>;
  } catch {
    log("[EventGate] csp tbill reversal skipped: sleeves JSON invalid; accrual keys left in place");
    return { reversedUsd: 0 };
  }
  const csp = sleeves.csp;
  if (!csp || typeof csp !== "object" || Array.isArray(csp)) {
    log("[EventGate] csp tbill reversal skipped: csp sleeve card missing; accrual keys left in place");
    return { reversedUsd: 0 };
  }
  const paper = (csp as { paper?: unknown }).paper;
  if (!paper || typeof paper !== "object" || Array.isArray(paper)) {
    log("[EventGate] csp tbill reversal skipped: csp paper missing; accrual keys left in place");
    return { reversedUsd: 0 };
  }
  const realized = (paper as { realizedPnlUsd?: unknown }).realizedPnlUsd;
  if (typeof realized !== "number" || !Number.isFinite(realized)) {
    log("[EventGate] csp tbill reversal skipped: csp realized P/L missing; accrual keys left in place");
    return { reversedUsd: 0 };
  }
  (paper as { realizedPnlUsd: number }).realizedPnlUsd = Math.round((realized - amount) * 100) / 100;
  delete state.tbillAccruedUsd;
  delete state.tbillAccruedYmd;
  const sleevesJson = JSON.stringify(sleeves);
  const stateJson = JSON.stringify(state);
  const multi = redis.multi?.();
  if (multi) {
    multi.set(REDIS_KEYS.sleeves, sleevesJson);
    multi.set(REDIS_KEYS.cspState, stateJson);
    await multi.exec();
  } else {
    await redis.set(REDIS_KEYS.sleeves, sleevesJson);
    await redis.set(REDIS_KEYS.cspState, stateJson);
  }
  log(`[EventGate] csp tbill reversal reversed=${amount.toFixed(2)} (csp realized P/L only, no order)`);
  return { reversedUsd: amount };
}

function positiveUsd(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
