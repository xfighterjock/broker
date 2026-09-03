import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import argon2 from "argon2";
import type { DbPool } from "./db";

const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const DUMMY_PASSWORD = "timing-dummy-not-a-user";

export interface UserRecord {
  id: number;
  username: string;
  passwordHash: string;
  disabledAt: Date | null;
}

export interface SessionLookup {
  userId: number;
  username: string;
  tokenHash: string;
  expiresAt: Date;
  disabledAt: Date | null;
}

export interface UserDirectory {
  countUsers(): Promise<number>;
  findByUsername(username: string): Promise<UserRecord | null>;
  findById(id: number): Promise<UserRecord | null>;
  createUser(username: string, passwordHash: string): Promise<UserRecord>;
  createSession(input: {
    userId: number;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string;
  }): Promise<void>;
  findSession(tokenHash: string): Promise<SessionLookup | null>;
  touchSession(tokenHash: string): Promise<void>;
  revokeSession(tokenHash: string): Promise<void>;
}

export function normalizeUsername(raw: string): string {
  return raw.trim().toLowerCase();
}

export function validateUsername(raw: string): string | null {
  const username = normalizeUsername(raw);
  if (!USERNAME_RE.test(username)) return null;
  return username;
}

export function validatePassword(raw: string): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length < 8 || raw.length > 200) return null;
  return raw;
}

function argonOptions(): argon2.Options & { raw?: false } {
  const test = (process.env.NODE_ENV || "").toLowerCase() === "test";
  return {
    type: argon2.argon2id,
    memoryCost: test ? 2 ** 12 : 19456,
    timeCost: 2,
    parallelism: 1,
  };
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, argonOptions());
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sessionExpiry(now = new Date()): Date {
  return new Date(now.getTime() + SESSION_TTL_MS);
}

let dummyHashPromise: Promise<string> | null = null;

function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(DUMMY_PASSWORD);
  return dummyHashPromise;
}

export async function verifyPasswordAgainstUser(
  user: UserRecord | null,
  password: string,
): Promise<boolean> {
  const hash = user?.passwordHash ?? (await dummyHash());
  const ok = await verifyPassword(hash, password);
  if (!user || user.disabledAt) return false;
  return ok;
}

export class MemoryUserDirectory implements UserDirectory {
  users = new Map<number, UserRecord>();
  byName = new Map<string, number>();
  sessions = new Map<string, SessionLookup>();
  private nextId = 1;

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async findByUsername(username: string): Promise<UserRecord | null> {
    const id = this.byName.get(normalizeUsername(username));
    return id === undefined ? null : (this.users.get(id) ?? null);
  }

  async findById(id: number): Promise<UserRecord | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(username: string, passwordHash: string): Promise<UserRecord> {
    const name = normalizeUsername(username);
    if (this.byName.has(name)) throw new Error("username taken");
    const rec: UserRecord = {
      id: this.nextId++,
      username: name,
      passwordHash,
      disabledAt: null,
    };
    this.users.set(rec.id, rec);
    this.byName.set(name, rec.id);
    return rec;
  }

  async createSession(input: {
    userId: number;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string;
  }): Promise<void> {
    const user = this.users.get(input.userId);
    if (!user) throw new Error("user not found");
    this.sessions.set(input.tokenHash, {
      userId: user.id,
      username: user.username,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      disabledAt: user.disabledAt,
    });
  }

  async findSession(tokenHash: string): Promise<SessionLookup | null> {
    const row = this.sessions.get(tokenHash);
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    const user = this.users.get(row.userId);
    if (!user) return null;
    return { ...row, username: user.username, disabledAt: user.disabledAt };
  }

  async touchSession(tokenHash: string): Promise<void> {
    void tokenHash;
  }

  async revokeSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }
}

export class PostgresUserDirectory implements UserDirectory {
  constructor(private readonly pool: DbPool) {}

  async countUsers(): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM users");
    return Number(rows[0]?.n ?? 0);
  }

  async findByUsername(username: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT id, username, password_hash, disabled_at
       FROM users WHERE username = $1`,
      [normalizeUsername(username)],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async findById(id: number): Promise<UserRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT id, username, password_hash, disabled_at FROM users WHERE id = $1`,
      [id],
    );
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async createUser(username: string, passwordHash: string): Promise<UserRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO users (username, password_hash)
       VALUES ($1, $2)
       RETURNING id, username, password_hash, disabled_at`,
      [normalizeUsername(username), passwordHash],
    );
    return mapUser(rows[0]);
  }

  async createSession(input: {
    userId: number;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO user_sessions (user_id, token_hash, expires_at, user_agent)
       VALUES ($1, $2, $3, $4)`,
      [input.userId, input.tokenHash, input.expiresAt.toISOString(), input.userAgent ?? null],
    );
  }

  async findSession(tokenHash: string): Promise<SessionLookup | null> {
    const { rows } = await this.pool.query(
      `SELECT s.user_id, s.token_hash, s.expires_at, u.username, u.disabled_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1
         AND s.revoked_at IS NULL
         AND s.expires_at > now()`,
      [tokenHash],
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      userId: Number(r.user_id),
      username: String(r.username),
      tokenHash: String(r.token_hash),
      expiresAt: new Date(r.expires_at),
      disabledAt: r.disabled_at ? new Date(r.disabled_at) : null,
    };
  }

  async touchSession(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE user_sessions SET last_seen_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }

  async revokeSession(tokenHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [tokenHash],
    );
  }
}

function mapUser(r: {
  id: number | string;
  username: string;
  password_hash: string;
  disabled_at: Date | string | null;
}): UserRecord {
  return {
    id: Number(r.id),
    username: String(r.username),
    passwordHash: String(r.password_hash),
    disabledAt: r.disabled_at ? new Date(r.disabled_at) : null,
  };
}

export function createUserDirectory(pool: DbPool | null): UserDirectory {
  return pool ? new PostgresUserDirectory(pool) : new MemoryUserDirectory();
}

export async function createUserWithPassword(
  dir: UserDirectory,
  usernameRaw: string,
  passwordRaw: string,
): Promise<{ ok: true; username: string } | { ok: false; error: string }> {
  const username = validateUsername(usernameRaw);
  if (!username) return { ok: false, error: "invalid username" };
  if (!validatePassword(passwordRaw)) return { ok: false, error: "invalid password" };
  if (await dir.findByUsername(username)) return { ok: false, error: "username taken" };
  const passwordHash = await hashPassword(passwordRaw);
  await dir.createUser(username, passwordHash);
  return { ok: true, username };
}

export async function issueSession(
  dir: UserDirectory,
  user: UserRecord,
  userAgent?: string,
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = sessionExpiry();
  await dir.createSession({
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt,
    userAgent,
  });
  return { token, expiresAt };
}

export async function lookupBearer(dir: UserDirectory, token: string): Promise<SessionLookup | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const row = await dir.findSession(hashSessionToken(trimmed));
  if (!row || row.disabledAt) return null;
  await dir.touchSession(row.tokenHash);
  return row;
}

/**
 * First-user seed. Only when the table is empty.
 * Reads BOOTSTRAP_ADMIN_USER / BOOTSTRAP_ADMIN_PASSWORD from env — never logs them.
 */
export async function maybeBootstrapAdmin(
  dir: UserDirectory,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ created: boolean; username?: string }> {
  const count = await dir.countUsers();
  if (count > 0) return { created: false };
  const username = env.BOOTSTRAP_ADMIN_USER;
  const password = env.BOOTSTRAP_ADMIN_PASSWORD;
  if (!username || !password) return { created: false };
  const created = await createUserWithPassword(dir, username, password);
  if (!created.ok) return { created: false };
  return { created: true, username: created.username };
}

export function tokensEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const loginFailures = new Map<string, { n: number; reset: number }>();

export function loginAllowed(username: string): boolean {
  const key = normalizeUsername(username);
  const row = loginFailures.get(key);
  if (!row) return true;
  if (Date.now() > row.reset) {
    loginFailures.delete(key);
    return true;
  }
  return row.n < LOGIN_MAX_FAILURES;
}

export function noteLoginFailure(username: string): void {
  const key = normalizeUsername(username);
  const now = Date.now();
  const row = loginFailures.get(key);
  if (!row || now > row.reset) {
    loginFailures.set(key, { n: 1, reset: now + LOGIN_WINDOW_MS });
    return;
  }
  row.n += 1;
}

export function noteLoginSuccess(username: string): void {
  loginFailures.delete(normalizeUsername(username));
}

export function resetLoginFailures(): void {
  loginFailures.clear();
}

export { SESSION_TTL_MS };
