import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import * as Sentry from "@sentry/node";
import {
  createLogger,
  requestContextMiddleware,
} from "@chat-siris/logger";
import {
  stripClientIdentityHeaders,
  requestIdMiddleware,
} from "./middleware/request-id.middleware";
import { jwtMiddleware } from "./middleware/jwt.middleware";
import {
  createIpRateLimiter,
  createUserRateLimiter,
} from "./middleware/rate-limit.middleware";
import { createHealthRouter } from "./routes/health.routes";
import { proxyHandler } from "./routes/proxy.routes";
import { tradityGoneMiddleware } from "./middleware/tradity.middleware";

export { setRedisClient, resetRedisClient, pingRedis } from "./redis";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "api-gateway";

function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    initialScope: {
      tags: { service: SERVICE_NAME, phase: "6" },
    },
  });
}

initSentry();

export async function createApp(options?: {
  skipRateLimit?: boolean;
  ipRateLimitMax?: number;
}): Promise<Express> {
  const app = express();

  const corsOrigins = process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()) ?? [
    "http://localhost:3000",
  ];

  app.use(
    cors({
      origin: corsOrigins,
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id"],
    }),
  );
  app.use(express.json());
  app.use(cookieParser());
  app.use(requestContextMiddleware());
  app.use(stripClientIdentityHeaders);
  app.use(requestIdMiddleware);

  if (!options?.skipRateLimit) {
    const ipLimiter =
      options?.ipRateLimitMax !== undefined
        ? await (
            await import("./middleware/rate-limit.middleware")
          ).createTestIpRateLimiter(options.ipRateLimitMax)
        : await createIpRateLimiter();
    app.use(ipLimiter);
  }

  app.use(createHealthRouter());

  app.use(jwtMiddleware);

  if (!options?.skipRateLimit) {
    const userLimiter = await createUserRateLimiter();
    app.use(userLimiter);
  }

  app.use(tradityGoneMiddleware);

  app.all("/api/auth/*path", (req, res, next) => {
    void proxyHandler(req, res).catch(next);
  });

  app.use(
    (
      _err: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      if (!res.headersSent) {
        res.status(500).json({
          status: false,
          msg: "Internal server error",
        });
      }
    },
  );

  return app;
}

export async function startServer(): Promise<void> {
  const logger = createLogger(process.env.SERVICE_NAME ?? "api-gateway");
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);

  const app = await createApp();

  app.listen(port, () => {
    logger.info(`api-gateway listening on port ${port}`);
  });
}

if (require.main === module) {
  require("dotenv").config();
  require("./telemetry");
  startServer().catch((err: unknown) => {
    console.error("Failed to start api-gateway:", err);
    process.exit(1);
  });
}
