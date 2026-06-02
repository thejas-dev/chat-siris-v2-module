import type { ChannelJson } from "../models/group.model";
import { getCacheRedis } from "../redis";

const PUBLIC_CHANNELS_TTL = 30;
const CHANNEL_NAME_TTL = 120;
const CHANNEL_MEMBERS_TTL = 60;
const AUTHZ_TTL = 30;

export function publicChannelsKey(): string {
  return "chat:channels:public";
}

export function channelNameKey(name: string): string {
  return `chat:channel:name:${name}`;
}

export function channelMembersKey(channelId: string): string {
  return `chat:channel:${channelId}:members`;
}

export function authzKey(userId: string, channelId: string): string {
  return `chat:authz:${userId}:${channelId}`;
}

export async function getCachedPublicChannels(): Promise<ChannelJson[] | null> {
  try {
    const redis = await getCacheRedis();
    const raw = await redis.get(publicChannelsKey());
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as ChannelJson[];
  } catch {
    return null;
  }
}

export async function cachePublicChannels(channels: ChannelJson[]): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.set(publicChannelsKey(), JSON.stringify(channels), {
      EX: PUBLIC_CHANNELS_TTL,
    });
  } catch {
    /* cache write failure must not fail request */
  }
}

export async function getCachedChannelByName(
  name: string,
): Promise<ChannelJson | null> {
  try {
    const redis = await getCacheRedis();
    const raw = await redis.get(channelNameKey(name));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as ChannelJson;
  } catch {
    return null;
  }
}

export async function cacheChannelByName(channel: ChannelJson): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.set(channelNameKey(channel.name), JSON.stringify(channel), {
      EX: CHANNEL_NAME_TTL,
    });
  } catch {
    /* ignore */
  }
}

export async function getCachedMembers(
  channelId: string,
): Promise<ChannelJson["users"] | null> {
  try {
    const redis = await getCacheRedis();
    const raw = await redis.get(channelMembersKey(channelId));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as ChannelJson["users"];
  } catch {
    return null;
  }
}

export async function cacheMembers(
  channelId: string,
  users: ChannelJson["users"],
): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.set(channelMembersKey(channelId), JSON.stringify(users), {
      EX: CHANNEL_MEMBERS_TTL,
    });
  } catch {
    /* ignore */
  }
}

export type AuthzCacheValue = {
  allowed: boolean;
  reason?: string;
};

export async function getCachedAuthz(
  userId: string,
  channelId: string,
): Promise<AuthzCacheValue | null> {
  try {
    const redis = await getCacheRedis();
    const raw = await redis.get(authzKey(userId, channelId));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as AuthzCacheValue;
  } catch {
    return null;
  }
}

export async function cacheAuthz(
  userId: string,
  channelId: string,
  value: AuthzCacheValue,
): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.set(authzKey(userId, channelId), JSON.stringify(value), {
      EX: AUTHZ_TTL,
    });
  } catch {
    /* ignore */
  }
}

export async function invalidateChannelCaches(
  channel: ChannelJson,
): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.del(publicChannelsKey());
    await redis.del(channelNameKey(channel.name));
    await redis.del(channelMembersKey(channel._id));
  } catch {
    /* ignore */
  }
}

export async function invalidateAuthzForChannel(channelId: string): Promise<void> {
  try {
    const redis = await getCacheRedis();
    const pattern = authzKey("*", channelId);
    if (pattern.includes("*")) {
      return;
    }
    await redis.del(authzKey("", channelId));
  } catch {
    /* ignore - full authz invalidation done via pub/sub subscriber */
  }
}

export async function invalidateAuthzEntry(
  userId: string,
  channelId: string,
): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.del(authzKey(userId, channelId));
  } catch {
    /* ignore */
  }
}
