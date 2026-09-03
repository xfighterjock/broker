import crypto from "node:crypto";
import fs from "node:fs";
import type { App } from "firebase-admin/app";
import type { Request } from "express";
import type { AppConfig } from "./config";
import type { DbPool } from "./db";

export const EVENT_GATE_ALERT_TYPES = [
  "risk_flip",
  "service_fault",
  "auth_needed",
  "paper_guard",
] as const;

export type EventGateAlertType = (typeof EVENT_GATE_ALERT_TYPES)[number];

export interface EventGateAlertPayload {
  title: string;
  body: string;
  eventType: EventGateAlertType;
  occurredAt: string;
  dedupeKey: string;
  deepLinkRoute: string;
}

export type SendOutcome = "delivered" | "error" | "disabled" | "not_configured" | "deduped";

export interface SendResult {
  outcome: SendOutcome;
  provider: "fcm";
  attempted: number;
  delivered: number;
  failed: number;
  skipped: number;
  reason?: string;
}

export interface NotificationProvider {
  readonly name: "fcm";
  readonly enabled: boolean;
  readonly configured: boolean;
  send(
    token: string,
    payload: EventGateAlertPayload,
  ): Promise<{ ok: true } | { ok: false; error: string }>;
}

export interface NotificationStatus {
  provider: "fcm";
  enabled: boolean;
  configured: boolean;
  dedupeWindowMinutes: number;
  tokens: { total: number; active: number; revoked: number };
}

const FCM_APP_NAME = "event-gate-fcm";
const DEFAULT_DEDUPE_MINUTES = 30;

let attachedService: NotificationService | null = null;

export function attachNotificationService(svc: NotificationService | null): void {
  attachedService = svc;
}

/** VPS-owned hook for risk-flip / operational guards. Not coupled to Mac/Grok Bot. */
export async function sendEventGateAlert(
  principal: string,
  payload: EventGateAlertPayload,
): Promise<SendResult> {
  if (!attachedService) {
    return emptyResult("disabled", "notification service not attached");
  }
  return attachedService.sendAlert(principal, payload);
}

export function isEventGateAlertType(value: string): value is EventGateAlertType {
  return (EVENT_GATE_ALERT_TYPES as readonly string[]).includes(value);
}

export function createEventGateAlert(input: EventGateAlertPayload): EventGateAlertPayload {
  if (!isEventGateAlertType(input.eventType)) {
    throw new Error("invalid eventType");
  }
  return {
    title: input.title.trim().slice(0, 120),
    body: input.body.trim().slice(0, 500),
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    dedupeKey: input.dedupeKey.trim().slice(0, 180),
    deepLinkRoute: input.deepLinkRoute.trim(),
  };
}

export function redactToken(token: string): string {
  const t = token.trim();
  if (t.length <= 10) return "***";
  return `${t.slice(0, 4)}…${t.slice(-4)}`;
}

export function tokenFingerprint(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function validateFcmToken(token: string): boolean {
  const trimmed = token.trim();
  if (trimmed.length < 20 || trimmed.length > 4096) return false;
  return /^[A-Za-z0-9:_\-.]+$/.test(trimmed);
}

export function resolvePushConfig(cfg: AppConfig): {
  enabled: boolean;
  configured: boolean;
  projectId: string | undefined;
  credentialSource: "adc" | "file";
  credentialPath: string | undefined;
  dedupeWindowMinutes: number;
} {
  const enabled = cfg.pushFcmEnabled === true;
  const projectId = cfg.pushFcmProjectId?.trim() || undefined;
  const credentialSource = cfg.pushFcmCredentialSource === "file" ? "file" : "adc";
  const credentialPath = cfg.pushFcmCredentialPath?.trim() || undefined;
  const fileReady = credentialSource !== "file" || Boolean(credentialPath && fs.existsSync(credentialPath));
  const configured = Boolean(enabled && projectId && fileReady);
  const window = Number(cfg.pushDedupeWindowMinutes);
  return {
    enabled,
    configured,
    projectId,
    credentialSource,
    credentialPath,
    dedupeWindowMinutes: Number.isFinite(window) && window >= 1 ? window : DEFAULT_DEDUPE_MINUTES,
  };
}

function emptyResult(outcome: SendOutcome, reason?: string): SendResult {
  return {
    outcome,
    provider: "fcm",
    attempted: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
    reason,
  };
}

function sanitizeSendError(message: string, token?: string): string {
  let out = message.replace(/\s+/g, " ").trim().slice(0, 240);
  if (token && out.includes(token)) out = out.split(token).join(redactToken(token));
  out = out.replace(/[A-Za-z0-9:_\-.]{32,}/g, "[redacted]");
  return out || "fcm send failed";
}

function validDeepLinkRoute(route: string): boolean {
  return route.startsWith("/") && route.length <= 512 && !route.includes("://");
}

function validateDeviceLabel(label: string | undefined): string | null {
  if (!label) return null;
  const next = label.trim();
  if (!next) return null;
  return next.slice(0, 120);
}

function makeFcmProvider(cfg: AppConfig): NotificationProvider {
  const resolved = resolvePushConfig(cfg);
  if (!resolved.enabled || !resolved.configured || !resolved.projectId) {
    return {
      name: "fcm",
      enabled: resolved.enabled,
      configured: resolved.configured,
      async send() {
        return { ok: false, error: resolved.enabled ? "not_configured" : "disabled" };
      },
    };
  }

  const projectId = resolved.projectId;
  const credentialSource = resolved.credentialSource;
  const credentialPath = resolved.credentialPath;

  return {
    name: "fcm",
    enabled: true,
    configured: true,
    async send(token, payload) {
      try {
        const app = await getOrInitFirebaseApp(projectId, credentialSource, credentialPath);
        const { getMessaging } = await import("firebase-admin/messaging");
        await getMessaging(app).send({
          token,
          notification: { title: payload.title, body: payload.body },
          data: {
            eventType: payload.eventType,
            occurredAt: payload.occurredAt,
            dedupeKey: payload.dedupeKey,
            deepLinkRoute: payload.deepLinkRoute,
          },
          apns: {
            payload: {
              aps: { sound: "default" },
            },
          },
        });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: sanitizeSendError(err instanceof Error ? err.message : String(err), token) };
      }
    },
  };
}

async function getOrInitFirebaseApp(
  projectId: string,
  credentialSource: "adc" | "file",
  credentialPath: string | undefined,
): Promise<App> {
  // Dynamic import so a missing firebase-admin install cannot crash the app while push is disabled.
  const { applicationDefault, cert, getApps, initializeApp } = await import("firebase-admin/app");
  const existing = getApps().find((app) => app.name === FCM_APP_NAME);
  if (existing) return existing;
  if (credentialSource === "file") {
    if (!credentialPath) throw new Error("not_configured");
    const raw = fs.readFileSync(credentialPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return initializeApp({ projectId, credential: cert(parsed) }, FCM_APP_NAME);
  }
  return initializeApp({ projectId, credential: applicationDefault() }, FCM_APP_NAME);
}

export class NotificationService {
  private readonly provider: NotificationProvider;
  private readonly dedupeWindowMinutes: number;

  constructor(
    private readonly pool: DbPool | null,
    cfg: AppConfig,
    provider?: NotificationProvider,
  ) {
    const resolved = resolvePushConfig(cfg);
    this.provider = provider ?? makeFcmProvider(cfg);
    this.dedupeWindowMinutes = resolved.dedupeWindowMinutes;
  }

  principalFromReq(req: Request): string {
    const headerUser = req.get("x-remote-user") || req.get("x-forwarded-user");
    const candidate = String(headerUser || "event-gate").trim();
    return candidate.slice(0, 120) || "event-gate";
  }

  async registerToken(input: {
    principal: string;
    platform: string;
    token: string;
    deviceLabel?: string;
    replaceToken?: string;
  }): Promise<{ ok: true; tokenPreview: string } | { ok: false; error: string }> {
    const platform = input.platform.toLowerCase();
    if (platform !== "ios") return { ok: false, error: "platform must be ios" };
    if (!validateFcmToken(input.token)) return { ok: false, error: "invalid token format" };
    const replaceToken = input.replaceToken?.trim();
    if (replaceToken && !validateFcmToken(replaceToken)) return { ok: false, error: "invalid replaceToken format" };
    if (!this.pool) return { ok: false, error: "token persistence unavailable" };
    const label = validateDeviceLabel(input.deviceLabel);
    const token = input.token.trim();
    const now = new Date().toISOString();
    const tokenHash = tokenFingerprint(token);
    const replaceHash = replaceToken ? tokenFingerprint(replaceToken) : null;
    if (replaceHash) {
      await this.pool.query(
        `UPDATE notification_device_tokens
         SET token = $1, token_hash = $2, enabled = true, revoked_at = NULL, updated_at = $3, last_seen_at = $3, device_label = COALESCE($4, device_label)
         WHERE user_id = $5 AND platform = $6 AND token_hash = $7`,
        [token, tokenHash, now, label, input.principal, platform, replaceHash],
      );
    }
    await this.pool.query(
      `INSERT INTO notification_device_tokens (user_id, platform, token, token_hash, device_label, enabled, revoked_at, created_at, updated_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, true, NULL, $6, $6, $6)
       ON CONFLICT (token_hash) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         platform = EXCLUDED.platform,
         token = EXCLUDED.token,
         device_label = EXCLUDED.device_label,
         enabled = true,
         revoked_at = NULL,
         updated_at = EXCLUDED.updated_at,
         last_seen_at = EXCLUDED.last_seen_at`,
      [input.principal, platform, token, tokenHash, label, now],
    );
    return { ok: true, tokenPreview: redactToken(token) };
  }

  async revokeToken(input: {
    principal: string;
    platform: string;
    token: string;
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    const platform = input.platform.toLowerCase();
    if (platform !== "ios") return { ok: false, error: "platform must be ios" };
    if (!validateFcmToken(input.token)) return { ok: false, error: "invalid token format" };
    if (!this.pool) return { ok: false, error: "token persistence unavailable" };
    const tokenHash = tokenFingerprint(input.token.trim());
    await this.pool.query(
      `UPDATE notification_device_tokens
       SET enabled = false, revoked_at = now(), updated_at = now()
       WHERE user_id = $1 AND platform = $2 AND token_hash = $3`,
      [input.principal, platform, tokenHash],
    );
    return { ok: true };
  }

  private async dedupeAllowed(dedupeKey: string): Promise<boolean> {
    if (!this.pool) return true;
    const got = await this.pool.query<{ last_sent_at: Date }>(
      `SELECT last_sent_at FROM notification_alert_dedupe WHERE dedupe_key = $1`,
      [dedupeKey],
    );
    if (got.rowCount && got.rows[0]) {
      const last = new Date(got.rows[0].last_sent_at).getTime();
      if (Date.now() - last < this.dedupeWindowMinutes * 60_000) return false;
    }
    await this.pool.query(
      `INSERT INTO notification_alert_dedupe (dedupe_key, last_sent_at)
       VALUES ($1, now())
       ON CONFLICT (dedupe_key) DO UPDATE SET last_sent_at = EXCLUDED.last_sent_at`,
      [dedupeKey],
    );
    return true;
  }

  private async activeTokens(principal: string): Promise<string[]> {
    if (!this.pool) return [];
    const got = await this.pool.query<{ token: string }>(
      `SELECT token FROM notification_device_tokens
       WHERE user_id = $1 AND platform = 'ios' AND enabled = true AND revoked_at IS NULL`,
      [principal],
    );
    return got.rows.map((r) => r.token);
  }

  async sendAlert(principal: string, payload: EventGateAlertPayload): Promise<SendResult> {
    if (!isEventGateAlertType(payload.eventType) || !validDeepLinkRoute(payload.deepLinkRoute)) {
      return emptyResult("error", "invalid alert payload");
    }
    if (!this.provider.enabled) return emptyResult("disabled");
    if (!this.provider.configured) return emptyResult("not_configured");
    const allowed = await this.dedupeAllowed(payload.dedupeKey);
    if (!allowed) return emptyResult("deduped");
    const tokens = await this.activeTokens(principal);
    if (tokens.length === 0) {
      return { outcome: "delivered", provider: "fcm", attempted: 0, delivered: 0, failed: 0, skipped: 0 };
    }
    let delivered = 0;
    let failed = 0;
    for (const t of tokens) {
      const sent = await this.provider.send(t, payload);
      if (sent.ok) delivered += 1;
      else failed += 1;
    }
    return {
      outcome: failed > 0 && delivered === 0 ? "error" : "delivered",
      provider: "fcm",
      attempted: tokens.length,
      delivered,
      failed,
      skipped: 0,
      reason: failed > 0 ? "one_or_more_send_errors" : undefined,
    };
  }

  async sendTest(principal: string): Promise<SendResult> {
    return this.sendAlert(
      principal,
      createEventGateAlert({
        title: "Event Gate test notification",
        body: "This is a harmless Event Gate push test.",
        eventType: "paper_guard",
        occurredAt: new Date().toISOString(),
        dedupeKey: "event-gate-test",
        deepLinkRoute: "/status",
      }),
    );
  }

  async status(): Promise<NotificationStatus> {
    let total = 0;
    let active = 0;
    let revoked = 0;
    if (this.pool) {
      const got = await this.pool.query<{ total: string; active: string; revoked: string }>(
        `SELECT
          COUNT(*)::text AS total,
          COUNT(*) FILTER (WHERE enabled = true AND revoked_at IS NULL)::text AS active,
          COUNT(*) FILTER (WHERE enabled = false OR revoked_at IS NOT NULL)::text AS revoked
        FROM notification_device_tokens
        WHERE platform = 'ios'`,
      );
      total = Number(got.rows[0]?.total || 0);
      active = Number(got.rows[0]?.active || 0);
      revoked = Number(got.rows[0]?.revoked || 0);
    }
    return {
      provider: "fcm",
      enabled: this.provider.enabled,
      configured: this.provider.configured,
      dedupeWindowMinutes: this.dedupeWindowMinutes,
      tokens: { total, active, revoked },
    };
  }
}
