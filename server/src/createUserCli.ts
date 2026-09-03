/**
 * Create an Event Gate user (argon2id hash in Postgres).
 * Usage: npx tsx server/src/createUserCli.ts <username>
 * Password is read from stdin (or EVENTGATE_NEW_USER_PASSWORD for non-interactive VPS use).
 * Never prints the password.
 */
import { createInterface } from "node:readline";
import { maybeLoadAppDotenv } from "./massive";
import { loadConfig } from "./config";
import { createPool, runMigrations } from "./db";
import { createUserDirectory, createUserWithPassword } from "./users";

function readPassword(): Promise<string> {
  const fromEnv = process.env.EVENTGATE_NEW_USER_PASSWORD;
  if (fromEnv && fromEnv.length > 0) return Promise.resolve(fromEnv);
  if (!process.stdin.isTTY) {
    return new Promise((resolve, reject) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        buf += chunk;
      });
      process.stdin.on("end", () => resolve(buf.replace(/\r?\n$/, "")));
      process.stdin.on("error", reject);
    });
  }
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("Password (not echoed to logs): ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  maybeLoadAppDotenv();
  const username = process.argv[2];
  if (!username) {
    console.error("usage: npx tsx server/src/createUserCli.ts <username>");
    process.exit(1);
  }
  const password = await readPassword();
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  try {
    await runMigrations(pool);
    const dir = createUserDirectory(pool);
    const got = await createUserWithPassword(dir, username, password);
    if (!got.ok) {
      console.error(`[EventGate] create user failed: ${got.error}`);
      process.exit(1);
    }
    console.log(`[EventGate] created user ${got.username}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[EventGate] create user failed", err instanceof Error ? err.message : err);
  process.exit(1);
});
