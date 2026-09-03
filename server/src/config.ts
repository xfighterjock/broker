export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  bind: string;
  gatePassword: string | undefined;
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

  if (nodeEnv === "production" && !gatePassword) {
    console.error("[EventGate] GATE_PASSWORD is unset. Refusing to start in production.");
    process.exit(1);
  }
  if (!gatePassword) {
    console.warn(
      "[EventGate] GATE_PASSWORD is unset. UI is open. Do not expose this process on a public interface.",
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
    tradingMode,
    nodeEnv,
    cookieSecure: env.COOKIE_SECURE === "1" || nodeEnv === "production",
    authMode: (env.AUTH_MODE || (nodeEnv === "production" ? "nginx" : "cookie")).toLowerCase(),
    tradovateBaseUrl: env.TRADOVATE_BASE_URL,
    pushFcmEnabled: env.PUSH_FCM_ENABLED === "1",
    pushFcmProjectId: env.PUSH_FCM_PROJECT_ID?.trim() || undefined,
    pushFcmCredentialSource: env.PUSH_FCM_CREDENTIAL_SOURCE === "file" ? "file" : "adc",
    pushFcmCredentialPath: env.PUSH_FCM_CREDENTIAL_PATH?.trim() || undefined,
    pushDedupeWindowMinutes: Math.max(1, Number(env.PUSH_ALERT_DEDUPE_WINDOW_MINUTES || 30)),
  };
}
