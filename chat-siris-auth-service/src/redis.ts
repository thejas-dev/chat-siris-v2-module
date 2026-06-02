import { createClient, type RedisClientType } from "redis";
import { resolveCacheDbIndex, resolveCacheRedisUrl } from "@chat-siris/logger";

export type AppRedis = Pick<
  RedisClientType,
  "get" | "set" | "del" | "ping" | "ttl" | "incr" | "expire" | "sendCommand"
>;

let redisClient: RedisClientType | null = null;
let usingInjectedClient = false;

export function createRedisClient(): RedisClientType {
  return createClient({
    url: resolveCacheRedisUrl(),
    database: resolveCacheDbIndex(),
  });
}

export async function getRedis(): Promise<AppRedis> {
  if (!redisClient) {
    redisClient = createRedisClient();
    await redisClient.connect();
    usingInjectedClient = false;
  }
  return redisClient;
}

/** Test hook — inject a mock Redis client. */
export function setRedisClient(client: AppRedis): void {
  redisClient = client as RedisClientType;
  usingInjectedClient = true;
}

/** Test hook — reset singleton between tests. */
export function resetRedisClient(): void {
  if (redisClient && !usingInjectedClient && redisClient.isOpen) {
    void redisClient.quit();
  }
  redisClient = null;
  usingInjectedClient = false;
}

export async function pingRedis(redis?: AppRedis): Promise<boolean> {
  try {
    const client = redis ?? (await getRedis());
    const result = await client.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}
