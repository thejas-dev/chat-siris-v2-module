import Redis, { type RedisOptions } from "ioredis";
import {
  resolveCacheDbIndex,
  resolveCacheRedisUrl,
  resolveEventsDbIndex,
  resolveEventsRedisUrl,
} from "@chat-siris/logger";

let redisClient: Redis | null = null;
let eventsRedisClient: Redis | null = null;

function cacheRedisOptions(url: string): RedisOptions {
  return {
    db: resolveCacheDbIndex(),
    maxRetriesPerRequest: 1,
    lazyConnect: true,
    tls: url.startsWith("rediss://") ? {} : undefined,
  };
}

export function createRedisClient(): Redis {
  const url = resolveCacheRedisUrl();
  return new Redis(url, cacheRedisOptions(url));
}

export function createEventsRedisClient(): Redis {
  const url = resolveEventsRedisUrl();
  return new Redis(url, {
    db: resolveEventsDbIndex(),
    maxRetriesPerRequest: null,
    lazyConnect: true,
    tls: url.startsWith("rediss://") ? {} : undefined,
  });
}

export function getRedis(): Redis {
  if (!redisClient) {
    redisClient = createRedisClient();
  }
  return redisClient;
}

export function getEventsRedis(): Redis {
  if (!eventsRedisClient) {
    eventsRedisClient = createEventsRedisClient();
  }
  return eventsRedisClient;
}

/** Test hook — inject a mock Redis client. */
export function setRedisClient(client: Redis): void {
  redisClient = client;
}

/** Test hook — reset singleton between tests. */
export function resetRedisClient(): void {
  redisClient = null;
  eventsRedisClient = null;
}

export async function pingRedis(redis: Redis = getRedis()): Promise<boolean> {
  try {
    if (redis.status !== "ready") {
      await redis.connect();
    }
    const result = await redis.ping();
    return result === "PONG";
  } catch {
    return false;
  }
}
