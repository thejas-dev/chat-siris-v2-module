import { getCacheRedis } from "../redis";

const PRESENCE_TTL_SEC = 60;

export function presenceKey(userId: string): string {
  return `chat:presence:user:${userId}`;
}

export async function setUserPresence(userId: string, socketId: string): Promise<void> {
  const redis = await getCacheRedis();
  await redis.set(presenceKey(userId), socketId, { EX: PRESENCE_TTL_SEC });
}

export async function clearUserPresence(userId: string): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.del(presenceKey(userId));
  } catch {
    /* non-fatal */
  }
}
