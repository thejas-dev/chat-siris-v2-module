import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { Request } from "express";
import { getRedis } from "../redis";

async function createStore(prefix: string): Promise<RedisStore> {
  const redis = await getRedis();
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => redis.sendCommand(args),
  });
}

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? req.ip ?? "unknown";
  }
  return req.ip ?? "unknown";
}

export async function createLoginRateLimiter() {
  const store = await createStore("rl:auth:login:");
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req) => `chat:rl:auth:login:${clientIp(req)}`,
    handler: (_req, res) => {
      res.status(429).json({
        status: false,
        msg: "Too many login attempts. Please try again later.",
      });
    },
  });
}

export async function createRegisterRateLimiter() {
  const store = await createStore("rl:auth:register:");
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req) => `chat:rl:auth:register:${clientIp(req)}`,
    handler: (_req, res) => {
      res.status(429).json({
        status: false,
        msg: "Too many registration attempts. Please try again later.",
      });
    },
  });
}

export async function createRefreshRateLimiter() {
  const store = await createStore("rl:auth:refresh:");
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req) => {
      const userId =
        (req as Request & { refreshUserId?: string }).refreshUserId ??
        "unknown";
      return `chat:rl:auth:refresh:${userId}`;
    },
    handler: (_req, res) => {
      res.status(429).json({
        status: false,
        msg: "Too many refresh attempts. Please try again later.",
      });
    },
  });
}

/** Test hook — no-op; stores are created per limiter. */
export function resetRateLimitStore(): void {
  /* retained for test symmetry */
}
