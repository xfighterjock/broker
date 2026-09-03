import { authMode as resolveAuthMode } from "./auth";

export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  bind: string;
  gatePassword: string | undefined;
  /** Cookie signing secret. Production users mode requires this or GATE_PASSWORD. */
  sessionSecret?: string;
  tradingMode: string;
  nodeEnv: string;
  cookieSecure: boolean;
  authMode: string;
  tradovateBaseUrl: string | undefined;
  /** Explicit opt-in. Missing/false keeps FCM disabled (fail closed). */
  pushFcmEnabled?: boolean;
  pushFcmProjectId?: string;
  pushFcmCredentialSource?: "adc" | "file";
  pushFcmCredentialPath?: string;
  pushDedupeWindowMinutes?: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = env.NODE_ENV || "development";
  const gatePassword = env.GATE_PASSWORD && env.GATE_PASSWORD.length > 0
    ? env.GATE_PASSWORD
    : undefined;
  const sessionSecret = env.SESSION_SECRET && env.SESSION_SECRET.length > 0
    ? env.SESSION_SECRET
    : undefined;
  const authMode = resolveAuthMode(env);

  if (nodeEnv === "production") {
    if (authMode === "users") {
      if (!sessionSecret && !gatePassword) {
        console.error(
          "[EventGate] SESSION_SECRET (or GATE_PASSWORD as cookie-signing fallback) is required in production.",
        );
        process.exit(1);
      }
    } else if (!gatePassword) {
      console.error("[EventGate] GATE_PASSWORD is unset. Refusing to start in production.");
      process.exit(1);
    }
  } else if (authMode !== "users" && !gatePassword) {
    console.warn(
      "[EventGate] GATE_PASSWORD is unset. Cookie-mode UI is open. Do not expose this process on a public interface.",
    );
  }

  const tradingMode = (env.TRADING_MODE || "mock").toLowerCase();
  if (tradingMode === "live") {
    console.error("[EventGate] TRADING_MODE=live is refused. Paper/demo only. Exiting.");
    process.exit(1);
  }

  return {
    databaseUrl: env.DATABASE_URL || "postgres://eventgate:eventgate@127.0.0.1:5432/eventgate",
    redisUrl: env.REDIS_URL || "redis://127.0.0.1:6379",
    port: Number(env.PORT || 3001),
    bind: env.BIND || "127.0.0.1",
    gatePassword,
    sessionSecret,
    tradingMode,
    nodeEnv,
    cookieSecure: env.COOKIE_SECURE === "1" || nodeEnv === "production",
    authMode,
    tradovateBaseUrl: env.TRADOVATE_BASE_URL,
    pushFcmEnabled: env.PUSH_FCM_ENABLED === "1",
    pushFcmProjectId: env.PUSH_FCM_PROJECT_ID?.trim() || undefined,
    pushFcmCredentialSource: env.PUSH_FCM_CREDENTIAL_SOURCE === "file" ? "file" : "adc",
    pushFcmCredentialPath: env.PUSH_FCM_CREDENTIAL_PATH?.trim() || undefined,
    pushDedupeWindowMinutes: Math.max(1, Number(env.PUSH_ALERT_DEDUPE_WINDOW_MINUTES || 30)),
  };
}
