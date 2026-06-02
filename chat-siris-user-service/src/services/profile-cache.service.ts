import type { ProfileJson } from "../models/profile.model";
import { getRedis } from "../redis";

const PROFILE_CACHE_TTL_SEC = Number.parseInt(
  process.env.PROFILE_CACHE_TTL_SEC ?? "300",
  10,
);

export function profileCacheKey(userId: string): string {
  return `chat:user:${userId}`;
}

export async function getCachedProfile(
  userId: string,
): Promise<ProfileJson | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(profileCacheKey(userId));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as ProfileJson;
  } catch {
    return null;
  }
}

export async function cacheProfile(profile: ProfileJson): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(
      profileCacheKey(profile._id),
      JSON.stringify(profile),
      "EX",
      PROFILE_CACHE_TTL_SEC,
    );
  } catch {
    // Cache write failure must not fail the request.
  }
}

export async function invalidateProfileCache(userId: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(profileCacheKey(userId));
  } catch {
    // Cache invalidation failure must not fail the request.
  }
}
