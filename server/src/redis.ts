import { createClient } from "redis";
import { noteServiceDown, noteServiceUp } from "./eventGateAlerts";

export type RedisClient = ReturnType<typeof createClient>;

export async function connectRedis(url: string): Promise<{
  client: RedisClient;
  pub: RedisClient;
  sub: RedisClient;
}> {
  const client = createClient({ url });
  client.on("error", (err) => {
    console.error("[EventGate] redis error", err);
    void noteServiceDown("redis");
  });
  client.on("ready", () => {
    noteServiceUp("redis");
  });
  await client.connect();
  const pub = client.duplicate();
  await pub.connect();
  const sub = client.duplicate();
  await sub.connect();
  return { client, pub, sub };
}

export async function redisPing(url: string): Promise<boolean> {
  const c = createClient({ url });
  try {
    await c.connect();
    const pong = await c.ping();
    await c.quit();
    return pong === "PONG";
  } catch {
    try {
      await c.quit();
    } catch {
      /* ignore */
    }
    return false;
  }
}
