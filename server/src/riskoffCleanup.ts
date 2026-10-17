import { REDIS_KEYS } from "../../shared/constants";
import type { Position, WorkingOrder } from "../../shared/types";
import type { MockBroker } from "./mockBroker";

const RETIRED_SLEEVE = "riskoff";

export interface RiskoffCleanupCounts {
  flattened: number;
  positionsDeleted: number;
  ordersDeleted: number;
  blotterDeleted: number;
  sleeveCardsDeleted: number;
  sessionMarksDeleted: number;
  redisKeysDeleted: number;
  autoPaperRewritten: number;
  sqlRowsDeleted: number;
}

export interface RiskoffCleanupDeps {
  broker: MockBroker;
  redis?: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<unknown>;
    del(key: string): Promise<unknown>;
  } | null;
  pool?: { query(sql: string, params?: unknown[]): Promise<{ rowCount?: number | null }> } | null;
  log?: (line: string) => void;
}

function zeroCounts(): RiskoffCleanupCounts {
  return {
    flattened: 0,
    positionsDeleted: 0,
    ordersDeleted: 0,
    blotterDeleted: 0,
    sleeveCardsDeleted: 0,
    sessionMarksDeleted: 0,
    redisKeysDeleted: 0,
    autoPaperRewritten: 0,
    sqlRowsDeleted: 0,
  };
}

function isRetiredSleeve(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === RETIRED_SLEEVE;
}

/**
 * One-time, idempotent paper cleanup. Flattens open risk-off mock lots (no
 * live orders), then deletes risk-off Redis and SQL rows. Other sleeves and
 * the RISK ON/OFF regime calculation are left alone. A second call is a no-op
 * besides zero counts.
 */
export async function purgeRiskoffSleeve(deps: RiskoffCleanupDeps): Promise<RiskoffCleanupCounts> {
  const counts = zeroCounts();
  const log = deps.log ?? (() => {});
  const open = deps.broker.getPositionsSync().filter((p) => isRetiredSleeve(p.sleeveId));
  for (const p of open) {
    if (p.side !== "Flat" && p.qty > 0) {
      deps.broker.addRealizedPnl(p.unrealizedPnl);
      counts.flattened += 1;
    }
  }
  const removed = deps.broker.removeBySleeveId(RETIRED_SLEEVE);
  counts.positionsDeleted = removed.positions.length;
  counts.ordersDeleted = removed.orders.length;

  if (deps.redis) {
    counts.blotterDeleted += await stripJsonArray(deps.redis, REDIS_KEYS.blotter, (row) => !isRetiredSleeve((row as { sleeveId?: unknown }).sleeveId));
    counts.sleeveCardsDeleted += await stripRecordKey(deps.redis, REDIS_KEYS.sleeves, RETIRED_SLEEVE);
    counts.sessionMarksDeleted += await stripRecordKey(deps.redis, REDIS_KEYS.sessionMarks, RETIRED_SLEEVE);
    counts.autoPaperRewritten += await stripAutoPaper(deps.redis);
    try {
      const existing = await deps.redis.get(REDIS_KEYS.riskoffDistributions);
      if (existing !== null) {
        await deps.redis.del(REDIS_KEYS.riskoffDistributions);
        counts.redisKeysDeleted += 1;
      }
    } catch {
      /* redis optional in tests */
    }
  }

  if (deps.pool) {
    const statements = [
      `DELETE FROM gate_log WHERE line ~ '(^|[^A-Za-z])riskoff([^A-Za-z]|$)'`,
      `DELETE FROM session_logs WHERE COALESCE(notes, '') ~ '(^|[^A-Za-z])riskoff([^A-Za-z]|$)' OR COALESCE(event_type, '') ~ '(^|[^A-Za-z])riskoff([^A-Za-z]|$)'`,
      `DELETE FROM notification_alert_dedupe WHERE dedupe_key ~ '(^|[^A-Za-z])riskoff([^A-Za-z]|$)'`,
    ];
    for (const sql of statements) {
      try {
        const res = await deps.pool.query(sql);
        counts.sqlRowsDeleted += res.rowCount ?? 0;
      } catch {
        /* table missing in a partial database */
      }
    }
  }

  log(
    `[EventGate] riskoff purge flattened=${counts.flattened} positions=${counts.positionsDeleted} orders=${counts.ordersDeleted} blotter=${counts.blotterDeleted} cards=${counts.sleeveCardsDeleted} marks=${counts.sessionMarksDeleted} redisKeys=${counts.redisKeysDeleted} autoRewritten=${counts.autoPaperRewritten} sql=${counts.sqlRowsDeleted}`,
  );
  return counts;
}

async function stripJsonArray(
  redis: NonNullable<RiskoffCleanupDeps["redis"]>,
  key: string,
  keep: (row: unknown) => boolean,
): Promise<number> {
  const raw = await redis.get(key);
  if (!raw) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!Array.isArray(parsed)) return 0;
  const next = parsed.filter(keep);
  const deleted = parsed.length - next.length;
  if (deleted > 0) await redis.set(key, JSON.stringify(next));
  return deleted;
}

async function stripRecordKey(
  redis: NonNullable<RiskoffCleanupDeps["redis"]>,
  key: string,
  field: string,
): Promise<number> {
  const raw = await redis.get(key);
  if (!raw) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  const obj = parsed as Record<string, unknown>;
  if (!(field in obj)) return 0;
  delete obj[field];
  await redis.set(key, JSON.stringify(obj));
  return 1;
}

async function stripAutoPaper(redis: NonNullable<RiskoffCleanupDeps["redis"]>): Promise<number> {
  const raw = await redis.get(REDIS_KEYS.autoPaper);
  if (!raw || raw === "0" || raw === "1") return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 0;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
  const obj = parsed as Record<string, unknown>;
  if (!("riskoff" in obj)) return 0;
  delete obj.riskoff;
  if (!("csp" in obj)) obj.csp = true;
  await redis.set(REDIS_KEYS.autoPaper, JSON.stringify(obj));
  return 1;
}

export function retiredSleevePositions(positions: Position[]): Position[] {
  return positions.filter((p) => isRetiredSleeve(p.sleeveId));
}

export function retiredSleeveOrders(orders: WorkingOrder[]): WorkingOrder[] {
  return orders.filter((o) => isRetiredSleeve(o.sleeveId));
}
