import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { Request } from "express";
import { getCacheRedis } from "../redis";

async function createStore(prefix: string): Promise<RedisStore> {
  const redis = await getCacheRedis();
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => redis.sendCommand(args),
  });
}

export async function createUploadRateLimiter() {
  const store = await createStore("rl:media:upload:");
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req: Request) => {
      const userId = req.gatewayUserId ?? "unknown";
      return `chat:rl:media:upload:${userId}`;
    },
    handler: (_req, res) => {
      res.status(429).json({
        status: false,
        msg: "Too many upload requests. Please try again later.",
      });
    },
  });
}

export function resetRateLimitStore(): void {
  /* retained for test symmetry */
}
