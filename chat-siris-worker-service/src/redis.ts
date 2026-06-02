import { createClient, type RedisClientType } from "redis";
import {
  buildBullMqConnection,
  resolveCacheDbIndex,
  resolveCacheRedisUrl,
  resolveEventsDbIndex,
  resolveEventsRedisUrl,
} from "@chat-siris/logger";

let cacheClient: RedisClientType | null = null;

export function createCacheRedisClient(): RedisClientType {
  return createClient({
    url: resolveCacheRedisUrl(),
    database: resolveCacheDbIndex(),
  });
}

export async function getCacheRedis(): Promise<RedisClientType> {
  if (!cacheClient) {
    cacheClient = createCacheRedisClient();
    await cacheClient.connect();
  }
  return cacheClient;
}

export function idempotencyKey(jobKey: string): string {
  return `chat:worker:idempotency:${jobKey}`;
}

export async function isChannelSyncProcessed(jobKey: string): Promise<boolean> {
  const redis = await getCacheRedis();
  const exists = await redis.exists(idempotencyKey(jobKey));
  return exists === 1;
}

export async function markChannelSyncProcessed(jobKey: string): Promise<void> {
  const redis = await getCacheRedis();
  await redis.set(idempotencyKey(jobKey), "1", { EX: 86400 });
}

/** @deprecated Use isChannelSyncProcessed / markChannelSyncProcessed */
export async function markIdempotent(jobKey: string): Promise<boolean> {
  const redis = await getCacheRedis();
  const key = idempotencyKey(jobKey);
  const result = await redis.set(key, "1", { NX: true, EX: 86400 });
  return result === "OK";
}

export function getBullMqConnection(): ReturnType<typeof buildBullMqConnection> {
  return buildBullMqConnection();
}

export function setCacheRedisClient(client: RedisClientType): void {
  cacheClient = client;
}

export function resetCacheRedisClient(): void {
  if (cacheClient?.isOpen) {
    void cacheClient.quit();
  }
  cacheClient = null;
}

export async function pingCacheRedis(): Promise<boolean> {
  try {
    const redis = await getCacheRedis();
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}

export async function pingEventsRedis(): Promise<boolean> {
  try {
    const probe = createClient({
      url: resolveEventsRedisUrl(),
      database: resolveEventsDbIndex(),
    });
    await probe.connect();
    const ok = (await probe.ping()) === "PONG";
    await probe.quit();
    return ok;
  } catch {
    return false;
  }
}
