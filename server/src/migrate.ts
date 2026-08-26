import { loadConfig } from "./config";
import { createPool, runMigrations } from "./db";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  try {
    await runMigrations(pool);
    console.log("[EventGate] migrations complete");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[EventGate] migrate failed", err);
  process.exit(1);
});
