import { getCacheRedis } from "../redis";
import { lookupChannelByName } from "./group-client.service";

const CHANNEL_NAME_PREFIX = "chat:channel:name:";
const MEMBER_CACHE_PREFIX = "chat:rt:member:";
const MEMBER_CACHE_TTL_SEC = 30;

function channelNameKey(name: string): string {
  return `${CHANNEL_NAME_PREFIX}${name}`;
}

function memberCacheKey(userId: string, channelName: string): string {
  return `${MEMBER_CACHE_PREFIX}${userId}:${channelName}`;
}

function sameUserId(a: string, b: string): boolean {
  return a === b || a.toString() === b.toString();
}

type CachedChannel = {
  _id: string;
  name: string;
  users: Array<{ _id: string }>;
};

async function getChannelFromCache(
  channelName: string,
): Promise<CachedChannel | null> {
  try {
    const redis = await getCacheRedis();
    const raw = await redis.get(channelNameKey(channelName));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as CachedChannel;
  } catch {
    return null;
  }
}

function isMember(
  channel: { users: Array<{ _id: string }> },
  userId: string,
): boolean {
  return channel.users.some((user) => sameUserId(user._id, userId));
}

async function getCachedMembership(
  userId: string,
  channelName: string,
): Promise<boolean | null> {
  try {
    const redis = await getCacheRedis();
    const raw = await redis.get(memberCacheKey(userId, channelName));
    if (raw === "1") {
      return true;
    }
    if (raw === "0") {
      return false;
    }
    return null;
  } catch {
    return null;
  }
}

async function cacheMembership(
  userId: string,
  channelName: string,
  isMemberResult: boolean,
): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.set(memberCacheKey(userId, channelName), isMemberResult ? "1" : "0", {
      EX: MEMBER_CACHE_TTL_SEC,
    });
  } catch {
    /* non-fatal */
  }
}

export async function invalidateMembershipCache(
  channelName: string,
  userId?: string,
): Promise<void> {
  try {
    const redis = await getCacheRedis();
    if (userId) {
      await redis.del(memberCacheKey(userId, channelName));
      return;
    }

    const pattern = `${MEMBER_CACHE_PREFIX}*:${channelName}`;
    const keys: string[] = [];
    for await (const key of redis.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      keys.push(key);
    }
    if (keys.length > 0) {
      await redis.del(keys);
    }
  } catch {
    /* non-fatal */
  }
}

export async function verifyChannelMembership(
  userId: string,
  channelName: string,
): Promise<"member" | "not_member" | "unavailable"> {
  const cachedMember = await getCachedMembership(userId, channelName);
  if (cachedMember === true) {
    return "member";
  }
  // Do not trust a cached "not_member" — user may have joined via REST after a failed
  // socket attempt; always re-check channel membership from cache or group-service.

  const cachedChannel = await getChannelFromCache(channelName);
  if (cachedChannel) {
    const member = isMember(cachedChannel, userId);
    await cacheMembership(userId, channelName, member);
    return member ? "member" : "not_member";
  }

  const lookup = await lookupChannelByName(channelName, userId);
  if (lookup === "unavailable") {
    return "unavailable";
  }
  if (!lookup) {
    await cacheMembership(userId, channelName, false);
    return "not_member";
  }

  const member = isMember(lookup, userId);
  await cacheMembership(userId, channelName, member);
  return member ? "member" : "not_member";
}
