import type { ExtendedError } from "socket.io/dist/namespace";
import { getCacheRedis } from "../redis";

const KEY_PREFIX = "chat:rl:rt:connect:";

export function isConnectRateLimitEnabled(): boolean {
  const raw = process.env.CONNECT_RATE_LIMIT_DISABLED ?? "";
  return raw !== "true" && raw !== "1";
}

function maxConnections(): number {
  return Number.parseInt(process.env.CONNECT_RATE_LIMIT_MAX ?? "20", 10);
}

function windowSec(): number {
  return Number.parseInt(process.env.CONNECT_RATE_LIMIT_WINDOW_SEC ?? "300", 10);
}

function clientIp(handshake: {
  address?: string;
  headers: Record<string, string | string[] | undefined>;
}): string {
  const forwarded = handshake.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? "unknown";
  }
  return handshake.address ?? "unknown";
}

export async function checkConnectRateLimit(handshake: {
  address?: string;
  headers: Record<string, string | string[] | undefined>;
}): Promise<boolean> {
  if (!isConnectRateLimitEnabled()) {
    return true;
  }

  const ip = clientIp(handshake);
  const key = `${KEY_PREFIX}${ip}`;

  try {
    const redis = await getCacheRedis();
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, windowSec());
    }
    if (count > maxConnections()) {
      // Do not let rejected/retry handshakes inflate the counter.
      await redis.decr(key);
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

export function rateLimitError(): ExtendedError {
  const err = new Error("Too many connection attempts") as ExtendedError;
  err.data = { code: "RATE_LIMITED" };
  return err;
}
