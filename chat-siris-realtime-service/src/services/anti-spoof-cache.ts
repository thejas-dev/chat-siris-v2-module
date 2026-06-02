import { getCacheRedis } from "../redis";

const PREFIX = "chat:rt:msg-spoof:";
const TTL_SEC = 60;

export function antiSpoofKey(messageId: string): string {
  return `${PREFIX}${messageId}`;
}

export async function rememberMessageId(messageId: string): Promise<void> {
  try {
    const redis = await getCacheRedis();
    await redis.set(antiSpoofKey(messageId), "1", { EX: TTL_SEC });
  } catch {
    /* non-fatal */
  }
}

export async function isMessageIdAllowed(messageId: string): Promise<boolean> {
  try {
    const redis = await getCacheRedis();
    const exists = await redis.exists(antiSpoofKey(messageId));
    return exists === 1;
  } catch {
    return false;
  }
}
