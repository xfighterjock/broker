import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import type { CalendarEvent } from "../../shared/types";

const { Pool } = pg;

export type DbPool = pg.Pool;

export function createPool(databaseUrl: string): DbPool {
  return new Pool({
    connectionString: databaseUrl,
    max: 8,
  });
}

function migrationsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "db/migrations"),
    path.resolve(here, "../../db/migrations"),
    path.resolve(here, "../db/migrations"),
  ];
  for (const d of candidates) {
    if (fs.existsSync(d)) return d;
  }
  return candidates[0];
}

export async function runMigrations(pool: DbPool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) {
    console.warn(`[EventGate] no migrations dir at ${dir}`);
    return;
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const id = file;
    const exists = await pool.query("SELECT 1 FROM schema_migrations WHERE id = $1", [id]);
    if (exists.rowCount && exists.rowCount > 0) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
      await client.query("COMMIT");
      console.log(`[EventGate] applied migration ${id}`);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
}

export async function loadEvents(pool: DbPool): Promise<CalendarEvent[]> {
  const { rows } = await pool.query<{
    id: string;
    event_time_utc: Date;
    type: string;
    flatten_et: string;
  }>(
    `SELECT id, event_time_utc, type, flatten_et::text AS flatten_et
     FROM events
     ORDER BY event_time_utc ASC`,
  );
  return rows.map((r) => {
    const flatten = (r.flatten_et || "15:45:00").slice(0, 5);
    return {
      id: String(r.id),
      timeUtc: new Date(r.event_time_utc).toISOString().replace(".000Z", "Z"),
      type: r.type,
      flattenEt: flatten,
      label: r.type.replace(/_/g, " "),
    };
  });
}

export interface FreezeRow {
  id: number;
  frozenAt: string | null;
  consensus: unknown;
  source: string | null;
  fedwatch: string | null;
  contracts: unknown;
  knowledgeTime: string | null;
}

export async function latestFreeze(pool: DbPool): Promise<FreezeRow | null> {
  const { rows } = await pool.query(
    `SELECT id, frozen_at, consensus, source, fedwatch, contracts, knowledge_time
     FROM freeze_snapshots
     ORDER BY id DESC
     LIMIT 1`,
  );
  if (!rows[0]) return null;
  const r = rows[0];
  return {
    id: r.id,
    frozenAt: r.frozen_at ? new Date(r.frozen_at).toISOString() : null,
    consensus: r.consensus,
    source: r.source,
    fedwatch: r.fedwatch,
    contracts: r.contracts,
    knowledgeTime: r.knowledge_time ? new Date(r.knowledge_time).toISOString() : null,
  };
}

export async function insertFreeze(
  pool: DbPool,
  input: {
    consensus: unknown;
    source: string;
    fedwatch: string;
    contracts: unknown;
    knowledgeTime: string | null;
    frozenAt: string | null;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO freeze_snapshots (frozen_at, consensus, source, fedwatch, contracts, knowledge_time)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      input.frozenAt,
      JSON.stringify(input.consensus),
      input.source,
      input.fedwatch,
      JSON.stringify(input.contracts),
      input.knowledgeTime,
    ],
  );
}

export async function stampKnowledgeTime(pool: DbPool, ts: Date): Promise<void> {
  const latest = await latestFreeze(pool);
  if (!latest) {
    await pool.query(
      `INSERT INTO freeze_snapshots (frozen_at, consensus, source, fedwatch, contracts, knowledge_time)
       VALUES (NULL, '{}'::jsonb, '', '', '{}'::jsonb, $1)`,
      [ts.toISOString()],
    );
    return;
  }
  await pool.query(`UPDATE freeze_snapshots SET knowledge_time = $1 WHERE id = $2`, [
    ts.toISOString(),
    latest.id,
  ]);
}

export async function insertGateLog(pool: DbPool, ts: string, line: string): Promise<void> {
  await pool.query(`INSERT INTO gate_log (ts, line) VALUES ($1, $2)`, [ts, line]);
}

export async function recentGateLog(pool: DbPool, limit = 200): Promise<{ ts: string; message: string }[]> {
  const { rows } = await pool.query(
    `SELECT ts, line FROM gate_log ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows
    .slice()
    .reverse()
    .map((r) => ({ ts: new Date(r.ts).toISOString(), message: r.line as string }));
}

export async function insertSessionLog(
  pool: DbPool,
  eventType: string,
  checklist: unknown,
  notes: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO session_logs (ts, event_type, checklist, notes) VALUES (now(), $1, $2, $3)`,
    [eventType, JSON.stringify(checklist ?? {}), notes],
  );
}

export async function recentSessionLogs(
  pool: DbPool,
  limit = 200,
): Promise<{ ts: string; kind: string; message: string }[]> {
  const { rows } = await pool.query(
    `SELECT ts, event_type, notes FROM session_logs ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  return rows
    .slice()
    .reverse()
    .map((r) => ({
      ts: new Date(r.ts).toISOString(),
      kind: r.event_type as string,
      message: r.notes as string,
    }));
}
