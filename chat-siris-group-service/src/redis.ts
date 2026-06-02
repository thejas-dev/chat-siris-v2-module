import { createClient, type RedisClientType } from "redis";
import {
  buildBullMqConnection,
  resolveCacheDbIndex,
  resolveCacheRedisUrl,
  resolveEventsDbIndex,
  resolveEventsRedisUrl,
} from "@chat-siris/logger";

export type AppRedis = Pick<
  RedisClientType,
  "get" | "set" | "del" | "ping" | "ttl" | "publish" | "duplicate"
>;

let cacheClient: RedisClientType | null = null;
let eventsClient: RedisClientType | null = null;
let usingInjectedCache = false;
let usingInjectedEvents = false;

export function createCacheRedisClient(): RedisClientType {
  return createClient({
    url: resolveCacheRedisUrl(),
    database: resolveCacheDbIndex(),
  });
}

export function createEventsRedisClient(): RedisClientType {
  return createClient({
    url: resolveEventsRedisUrl(),
    database: resolveEventsDbIndex(),
  });
}

export async function getCacheRedis(): Promise<AppRedis> {
  if (!cacheClient) {
    cacheClient = createCacheRedisClient();
    await cacheClient.connect();
    usingInjectedCache = false;
  }
  return cacheClient;
}

export async function getEventsRedis(): Promise<RedisClientType> {
  if (!eventsClient) {
    eventsClient = createEventsRedisClient();
    await eventsClient.connect();
    usingInjectedEvents = false;
  }
  return eventsClient;
}

export function setCacheRedisClient(client: AppRedis): void {
  cacheClient = client as RedisClientType;
  usingInjectedCache = true;
}

export function setEventsRedisClient(client: RedisClientType): void {
  eventsClient = client;
  usingInjectedEvents = true;
}

export function resetRedisClients(): void {
  if (cacheClient && !usingInjectedCache && cacheClient.isOpen) {
    void cacheClient.quit();
  }
  if (eventsClient && !usingInjectedEvents && eventsClient.isOpen) {
    void eventsClient.quit();
  }
  cacheClient = null;
  eventsClient = null;
  usingInjectedCache = false;
  usingInjectedEvents = false;
}

export async function pingCacheRedis(redis?: AppRedis): Promise<boolean> {
  try {
    const client = redis ?? (await getCacheRedis());
    const result = await client.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}

export function getBullMqConnection(): ReturnType<typeof buildBullMqConnection> {
  return buildBullMqConnection();
}
