/**
 * Redis scan cache and Postgres snapshot / shadow rows for the csp sleeve.
 * Paper only. No orders.
 */

import { REDIS_KEYS } from "../../shared/constants";
import type { ShadowRow } from "./cspMath";
import { CSP_SHADOW_RULES, type CspShadowRuleId } from "./cspMath";
import type { CspBetaRank, CspPendingSignal, CspSnapshotRow } from "./cspScan";

export interface CspPersistedState {
  scannedAt: string | null;
  scannedYmd: string | null;
  pending: CspPendingSignal[];
  ranked: CspBetaRank[];
  recorderSlots: string[];
  /** America/New_York date of the last T-bill credit. Null until the first credit. */
  tbillAccruedYmd: string | null;
  /** Cumulative T-bill interest credited to the csp book. */
  tbillAccruedUsd: number;
}

export function emptyCspState(): CspPersistedState {
  return {
    scannedAt: null,
    scannedYmd: null,
    pending: [],
    ranked: [],
    recorderSlots: [],
    tbillAccruedYmd: null,
    tbillAccruedUsd: 0,
  };
}

export function parseCspState(raw: string | null): CspPersistedState {
  if (!raw) return emptyCspState();
  try {
    const parsed = JSON.parse(raw) as Partial<CspPersistedState>;
    return {
      scannedAt: typeof parsed.scannedAt === "string" ? parsed.scannedAt : null,
      scannedYmd: typeof parsed.scannedYmd === "string" ? parsed.scannedYmd : null,
      pending: Array.isArray(parsed.pending) ? parsed.pending.filter(isPending) : [],
      ranked: Array.isArray(parsed.ranked) ? parsed.ranked.filter(isRank) : [],
      recorderSlots: Array.isArray(parsed.recorderSlots)
        ? parsed.recorderSlots.filter((s): s is string => typeof s === "string")
        : [],
      tbillAccruedYmd: typeof parsed.tbillAccruedYmd === "string" ? parsed.tbillAccruedYmd : null,
      tbillAccruedUsd:
        typeof parsed.tbillAccruedUsd === "number" && Number.isFinite(parsed.tbillAccruedUsd)
          ? parsed.tbillAccruedUsd
          : 0,
    };
  } catch {
    return emptyCspState();
  }
}

type RedisLike = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
};

export async function loadCspState(redis: RedisLike | null): Promise<CspPersistedState> {
  if (!redis) return emptyCspState();
  try {
    return parseCspState(await redis.get(REDIS_KEYS.cspState));
  } catch {
    return emptyCspState();
  }
}

export async function saveCspState(redis: RedisLike | null, state: CspPersistedState): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(REDIS_KEYS.cspState, JSON.stringify(state));
  } catch {
    /* memory copy still drives this process */
  }
}

type PoolLike = {
  query(sql: string, params?: unknown[]): Promise<{ rows?: unknown[]; rowCount?: number | null }>;
};

export async function insertCspSnapshots(
  pool: PoolLike | null,
  snapshotTs: string,
  rows: CspSnapshotRow[],
): Promise<number> {
  if (!pool || rows.length === 0) return 0;
  const chunk = 200;
  let written = 0;
  for (let i = 0; i < rows.length; i += chunk) {
    written += await insertSnapshotChunk(pool, snapshotTs, rows.slice(i, i + chunk));
  }
  return written;
}

async function insertSnapshotChunk(pool: PoolLike, snapshotTs: string, rows: CspSnapshotRow[]): Promise<number> {
  const values: unknown[] = [];
  const holders: string[] = [];
  rows.forEach((row, n) => {
    const base = n * 12;
    const slots = Array.from({ length: 12 }, (_, k) => `$${base + k + 1}`);
    holders.push(`(${slots.join(",")})`);
    values.push(
      snapshotTs,
      row.underlying,
      row.underlyingLast,
      row.expiration,
      row.strike,
      row.bid,
      row.ask,
      row.last,
      row.volume,
      row.openInterest,
      row.iv,
      row.delta,
    );
  });
  await pool.query(
    `INSERT INTO csp_option_snapshots
      (snapshot_ts, underlying, underlying_last, expiration, strike, bid, ask, last, volume, open_interest, iv, delta)
     VALUES ${holders.join(",")}`,
    values,
  );
  return rows.length;
}

export async function upsertCspShadows(pool: PoolLike | null, rows: ShadowRow[]): Promise<void> {
  if (!pool || rows.length === 0) return;
  for (const row of rows) {
    await pool.query(
      `INSERT INTO csp_shadow_exits
        (position_id, rule_id, triggered_at, underlying_px, put_bid, put_ask, put_mid, fill, pnl, final_actual_pnl)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (position_id, rule_id) DO UPDATE SET
         triggered_at = EXCLUDED.triggered_at,
         underlying_px = EXCLUDED.underlying_px,
         put_bid = EXCLUDED.put_bid,
         put_ask = EXCLUDED.put_ask,
         put_mid = EXCLUDED.put_mid,
         fill = EXCLUDED.fill,
         pnl = EXCLUDED.pnl,
         final_actual_pnl = EXCLUDED.final_actual_pnl`,
      [
        row.positionId,
        row.ruleId,
        row.triggeredAt,
        row.underlyingPx,
        row.putBid,
        row.putAsk,
        row.putMid,
        row.fill,
        row.pnl,
        row.finalActualPnl,
      ],
    );
  }
}

export async function loadCspShadows(pool: PoolLike | null): Promise<ShadowRow[]> {
  if (!pool) return [];
  try {
    const res = await pool.query(
      `SELECT position_id, rule_id, triggered_at, underlying_px, put_bid, put_ask, put_mid, fill, pnl, final_actual_pnl
       FROM csp_shadow_exits`,
    );
    const rows = Array.isArray(res.rows) ? res.rows : [];
    const out: ShadowRow[] = [];
    for (const raw of rows) {
      const row = raw as Record<string, unknown>;
      const ruleId = String(row.rule_id ?? "");
      if (!(CSP_SHADOW_RULES as readonly string[]).includes(ruleId)) continue;
      out.push({
        positionId: String(row.position_id ?? ""),
        ruleId: ruleId as CspShadowRuleId,
        triggeredAt: isoOrNull(row.triggered_at),
        underlyingPx: numOrNull(row.underlying_px),
        putBid: numOrNull(row.put_bid),
        putAsk: numOrNull(row.put_ask),
        putMid: numOrNull(row.put_mid),
        fill: numOrNull(row.fill),
        pnl: numOrNull(row.pnl),
        finalActualPnl: numOrNull(row.final_actual_pnl),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function isPending(v: unknown): v is CspPendingSignal {
  if (!v || typeof v !== "object") return false;
  const o = v as CspPendingSignal;
  return typeof o.symbol === "string" && typeof o.tradeYmd === "string" && typeof o.beta === "number";
}

function isRank(v: unknown): v is CspBetaRank {
  if (!v || typeof v !== "object") return false;
  const o = v as CspBetaRank;
  return typeof o.symbol === "string" && typeof o.beta === "number";
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v) return new Date(v).toISOString();
  return null;
}
