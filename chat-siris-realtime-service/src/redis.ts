import { createClient, type RedisClientType } from "redis";
import {
  resolveCacheDbIndex,
  resolveCacheRedisUrl,
  resolveEventsDbIndex,
  resolveEventsRedisUrl,
} from "@chat-siris/logger";

let cacheClient: RedisClientType | null = null;
let eventsClient: RedisClientType | null = null;
let eventsSubscriber: RedisClientType | null = null;
let usingInjectedCache = false;
let usingInjectedEvents = false;
let usingInjectedSubscriber = false;

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

export function createEventsSubscriberClient(): RedisClientType {
  return createClient({
    url: resolveEventsRedisUrl(),
    database: resolveEventsDbIndex(),
  });
}

export async function getCacheRedis(): Promise<RedisClientType> {
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

export async function getEventsSubscriber(): Promise<RedisClientType> {
  if (!eventsSubscriber) {
    eventsSubscriber = createEventsSubscriberClient();
    await eventsSubscriber.connect();
    usingInjectedSubscriber = false;
  }
  return eventsSubscriber;
}

export function setCacheRedisClient(client: RedisClientType): void {
  cacheClient = client;
  usingInjectedCache = true;
}

export function setEventsRedisClient(client: RedisClientType): void {
  eventsClient = client;
  usingInjectedEvents = true;
}

export function setEventsSubscriberClient(client: RedisClientType): void {
  eventsSubscriber = client;
  usingInjectedSubscriber = true;
}

export async function resetRedisClients(): Promise<void> {
  const clients = [
    { client: cacheClient, injected: usingInjectedCache },
    { client: eventsClient, injected: usingInjectedEvents },
    { client: eventsSubscriber, injected: usingInjectedSubscriber },
  ];

  for (const { client, injected } of clients) {
    if (client && !injected && client.isOpen) {
      await client.quit();
    }
  }

  cacheClient = null;
  eventsClient = null;
  eventsSubscriber = null;
  usingInjectedCache = false;
  usingInjectedEvents = false;
  usingInjectedSubscriber = false;
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
    const redis = await getEventsRedis();
    return (await redis.ping()) === "PONG";
  } catch {
    return false;
  }
}
