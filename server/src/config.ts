export interface AppConfig {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  bind: string;
  gatePassword: string | undefined;
  tradingMode: string;
  nodeEnv: string;
  cookieSecure: boolean;
  tradovateBaseUrl: string | undefined;
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
    cookieSecure: env.COOKIE_SECURE === "1",
    tradovateBaseUrl: env.TRADOVATE_BASE_URL,
  };
}
