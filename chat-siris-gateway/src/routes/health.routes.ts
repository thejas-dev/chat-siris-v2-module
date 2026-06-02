import { Router, type Request, type Response } from "express";
import { buildHealthResponse } from "@chat-siris/logger";
import { pingRedis } from "../redis";
import { getAuthServiceUrl } from "../config/route-map";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "api-gateway";
const VERSION = process.env.npm_package_version ?? "1.0.0";

async function pingAuthService(): Promise<boolean> {
  try {
    const response = await fetch(`${getAuthServiceUrl()}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { status?: string };
    return body.status === "ok";
  } catch {
    return false;
  }
}

export function createHealthRouter(): Router {
  const router = Router();

  router.get("/health", async (_req: Request, res: Response) => {
    const [redisOk, authOk] = await Promise.all([pingRedis(), pingAuthService()]);
    const status = redisOk && authOk ? "ok" : "degraded";

    res.status(status === "ok" ? 200 : 503).json(
      buildHealthResponse({
        service: SERVICE_NAME,
        version: VERSION,
        redis: redisOk,
      }),
    );
  });

  router.get("/health/aggregate", async (_req: Request, res: Response) => {
    const [redisOk, authOk] = await Promise.all([pingRedis(), pingAuthService()]);
    const overall = redisOk && authOk ? "ok" : "degraded";

    res.status(overall === "ok" ? 200 : 503).json({
      status: overall,
      service: SERVICE_NAME,
      uptime: process.uptime(),
      version: VERSION,
      dependencies: {
        redis: redisOk ? "ok" : "error",
        authService: authOk ? "ok" : "error",
      },
    });
  });

  return router;
}
