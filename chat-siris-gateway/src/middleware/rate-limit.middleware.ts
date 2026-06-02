import rateLimit, { type RateLimitRequestHandler } from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";
import type { Request, Response, NextFunction } from "express";
import { createLogger } from "@chat-siris/logger";
import { getRedis } from "../redis";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "api-gateway";
const logger = createLogger(SERVICE_NAME);

const WINDOW_MS = 60 * 1000;
const IP_MAX = Number.parseInt(process.env.RATE_LIMIT_IP_MAX ?? "100", 10);
const USER_MAX = Number.parseInt(process.env.RATE_LIMIT_USER_MAX ?? "300", 10);

function clientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() ?? req.ip ?? "unknown";
  }
  return req.ip ?? "unknown";
}

async function createStore(prefix: string): Promise<RedisStore> {
  const redis = await getRedis();
  return new RedisStore({
    prefix,
    sendCommand: (...args: string[]) => redis.sendCommand(args),
  });
}

function failOpenWrapper(
  limiter: RateLimitRequestHandler,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    limiter(req, res, (err?: unknown) => {
      if (err) {
        logger.warn("rate_limit_degraded", {
          requestId: req.logContext?.requestId,
          error: err instanceof Error ? err.message : String(err),
        });
        next();
        return;
      }
      next();
    });
  };
}

export async function createIpRateLimiter(): Promise<
  (req: Request, res: Response, next: NextFunction) => void
> {
  const store = await createStore("rl:gw:ip:");
  const limiter = rateLimit({
    windowMs: WINDOW_MS,
    max: IP_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req) => `chat:rl:gw:ip:${clientIp(req)}`,
    handler: (_req, res) => {
      res.status(429).json({
        status: false,
        msg: "Too many requests. Please try again later.",
      });
    },
    passOnStoreError: true,
  });

  return failOpenWrapper(limiter);
}

export async function createUserRateLimiter(): Promise<
  (req: Request, res: Response, next: NextFunction) => void
> {
  const store = await createStore("rl:gw:user:");
  const limiter = rateLimit({
    windowMs: WINDOW_MS,
    max: USER_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    skip: (req) => !req.authClaims?.userId,
    keyGenerator: (req) => {
      const userId = req.authClaims?.userId ?? clientIp(req);
      return `chat:rl:gw:user:${userId}`;
    },
    handler: (_req, res) => {
      res.status(429).json({
        status: false,
        msg: "Too many requests. Please try again later.",
      });
    },
    passOnStoreError: true,
  });

  return failOpenWrapper(limiter);
}

/** Test hook — create limiter with custom max for IP tests. */
export async function createTestIpRateLimiter(max: number): Promise<
  (req: Request, res: Response, next: NextFunction) => void
> {
  const store = await createStore("rl:gw:ip:test:");
  const limiter = rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    keyGenerator: (req) => `chat:rl:gw:ip:${clientIp(req)}`,
    handler: (_req, res) => {
      res.status(429).json({
        status: false,
        msg: "Too many requests. Please try again later.",
      });
    },
    passOnStoreError: true,
  });

  return failOpenWrapper(limiter);
}

export function createFailOpenRateLimiter(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    logger.warn("rate_limit_degraded", { reason: "redis_unavailable" });
    next();
  };
}
