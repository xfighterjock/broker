import type { Request, Response, NextFunction } from "express";
import session from "express-session";
import { RedisStore } from "connect-redis";
import type { RedisClient } from "./redis";

const COOKIE = "eg.sid";

declare module "express-session" {
  interface SessionData {
    authed?: boolean;
  }
}

export function gatePassword(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const p = env.GATE_PASSWORD;
  if (p === undefined || p === "") return undefined;
  return p;
}

export function authRequired(): boolean {
  return gatePassword() !== undefined;
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

export function authMode(env: NodeJS.ProcessEnv = process.env): string {
  return (env.AUTH_MODE || "cookie").toLowerCase();
}

function isLoopback(req: Request): boolean {
  const raw = req.socket.remoteAddress || "";
  return raw === "127.0.0.1" || raw === "::1" || raw === ":ffff:127.0.0.1";
}

export function isAuthed(req: Request): boolean {
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

export function requireAuthWs(req: Request): boolean {
  return isAuthed(req);
}
