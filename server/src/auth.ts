import type { Request, Response, NextFunction } from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import type { RedisClient } from "./redis";
import type { SessionLookup, UserDirectory } from "./users";
import { lookupBearer, tokensEqual } from "./users";

const COOKIE = "eg.sid";

declare module "express-session" {
  interface SessionData {
    authed?: boolean;
    userId?: number;
    username?: string;
  }
}

declare global {
  namespace Express {
    interface Request {
      eventGateUser?: { id: number; username: string };
      /** Narrow freeze/status scope from EVENT_GATE_OPS_TOKEN. Not a full user session. */
      eventGateOps?: boolean;
    }
  }
}

export const OPS_USERNAME = "ops-token";
export const OPS_USER_ID = 0;

const OPS_PUBLIC_PATHS = new Set([
  "/health",
  "/public/risk",
  "/auth/status",
  "/auth/login",
  "/auth/logout",
]);

export function gatePassword(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const p = env.GATE_PASSWORD;
  if (p === undefined || p === "") return undefined;
  return p;
}

/** Optional long-lived HTTPS ops bearer. When unset, ops auth is off. */
export function eventGateOpsToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const t = env.EVENT_GATE_OPS_TOKEN;
  if (t === undefined || t === "") return undefined;
  return t;
}

export function authMode(env: NodeJS.ProcessEnv = process.env): string {
  const nodeEnv = (env.NODE_ENV || "development").toLowerCase();
  const fallback = nodeEnv === "production" ? "users" : "cookie";
  const raw = (env.AUTH_MODE || fallback).toLowerCase();
  // nginx loopback-trust is unsafe once htpasswd is gone. Production always uses users.
  if (nodeEnv === "production" && raw === "nginx") return "users";
  return raw;
}

/** User-table login (SPA + iOS). Not GATE_PASSWORD and not nginx htpasswd. */
export function usersAuthMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return authMode(env) === "users";
}

export function authRequired(env: NodeJS.ProcessEnv = process.env): boolean {
  if (usersAuthMode(env)) return true;
  return gatePassword(env) !== undefined;
}

export function buildSessionMiddleware(redis: RedisClient, secret: string, cookieSecure: boolean) {
  return session({
    name: COOKIE,
    store: new RedisStore({ client: redis, prefix: "eg:sess:" }),
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: cookieSecure,
      maxAge: 7 * 24 * 3600 * 1000,
      path: "/",
    },
  });
}

function isLoopback(req: Request): boolean {
  const raw = req.socket.remoteAddress || "";
  return raw === "127.0.0.1" || raw === "::1" || raw === ":ffff:127.0.0.1";
}

export function bearerTokenFromReq(req: Request): string | null {
  const header = req.get("authorization") || req.get("Authorization") || "";
  const m = /^Bearer\s+(\S+)/i.exec(header.trim());
  return m?.[1] ?? null;
}

export function isAuthed(req: Request): boolean {
  if (req.eventGateUser) return true;
  if (usersAuthMode()) {
    return req.session?.authed === true && typeof req.session.userId === "number";
  }
  if (!authRequired()) return true;
  if (authMode() === "nginx" && isLoopback(req)) return true;
  return req.session?.authed === true;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (isAuthed(req)) {
    next();
    return;
  }
  res.status(401).json({ error: "auth required" });
}

/** Full user/cookie session only. Ops bearer is not an admin session. */
export function requireUserSession(req: Request, res: Response, next: NextFunction): void {
  if (req.eventGateOps) {
    res.status(401).json({ error: "ops token not permitted" });
    return;
  }
  requireAuth(req, res, next);
}

/** Fail-closed allowlist for EVENT_GATE_OPS_TOKEN. New routes stay denied. */
export function opsRouteAllowed(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (OPS_PUBLIC_PATHS.has(path)) return true;
  if (m === "GET" && path === "/status") return true;
  if (m === "GET" && path === "/freeze") return true;
  if (m === "PUT" && path === "/freeze") return true;
  if (m === "GET" && path === "/health") return true;
  if (m === "GET" && path === "/sleeves") return true;
  if (m === "GET" && path === "/essentials") return true;
  return false;
}

export function requireOpsScope(req: Request, res: Response, next: NextFunction): void {
  if (!req.eventGateOps) {
    next();
    return;
  }
  if (opsRouteAllowed(req.method, req.path)) {
    next();
    return;
  }
  res.status(401).json({ error: "ops token not permitted" });
}

export function requireAuthWs(req: Request): boolean {
  if (req.eventGateOps) return false;
  return isAuthed(req);
}

export function sessionUsername(req: Request): string | undefined {
  return req.eventGateUser?.username || req.session?.username || undefined;
}

export function attachBearerUser(req: Request, row: SessionLookup): void {
  req.eventGateUser = { id: row.userId, username: row.username };
}

export function attachOpsUser(req: Request): void {
  req.eventGateOps = true;
  req.eventGateUser = { id: OPS_USER_ID, username: OPS_USERNAME };
}

export function bearerAuthMiddleware(dir: UserDirectory) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const token = bearerTokenFromReq(req);
    if (!token) {
      next();
      return;
    }
    const ops = eventGateOpsToken();
    if (ops && tokensEqual(token, ops)) {
      attachOpsUser(req);
      next();
      return;
    }
    try {
      const row = await lookupBearer(dir, token);
      if (row) attachBearerUser(req, row);
    } catch {
      /* treat as anonymous; requireAuth will 401 */
    }
    next();
  };
}
