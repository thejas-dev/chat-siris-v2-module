import { getCacheRedis } from "../redis";
import type { MessageJson } from "../models/message.model";

export type CachedHistoryPage = {
  data: MessageJson[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
  };
};

const CACHE_TTL_SEC = 120;

function cacheKey(channelName: string): string {
  return `chat:messages:${channelName}`;
}

export async function getCachedHistoryPage(
  channelName: string,
): Promise<CachedHistoryPage | null> {
  try {
    const redis = await getCacheRedis();
    const raw = await redis.get(cacheKey(channelName));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as CachedHistoryPage;
  } catch {
    return null;
  }
}

export async function setCachedHistoryPage(
  channelName: string,
  page: CachedHistoryPage,
): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.set(cacheKey(channelName), JSON.stringify(page), {
      EX: CACHE_TTL_SEC,
    });
  } catch {
    /* cache failure must not fail primary request */
  }
}

export async function invalidateHistoryCache(channelName: string): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.del(cacheKey(channelName));
  } catch {
    /* cache failure must not fail primary request */
  }
}
