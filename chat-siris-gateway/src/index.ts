// Load env first, then telemetry (so OpenTelemetry can instrument http/express
// before those modules are required), then everything else.
import "dotenv/config";
import "./telemetry";
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

// createApp() is async (rate limiters read Redis); build it once and reuse it.
let appPromise: Promise<Express> | null = null;
function getApp(): Promise<Express> {
  if (!appPromise) {
    appPromise = createApp().catch((err: unknown) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

// Synchronous outer app so Vercel detects it as a single Serverless Function
// (zero-config Express). The inner app (health + proxy) is built on first request
// and handles everything. No Mongo here — the gateway is stateless HTTP + Redis.
const app = express();

app.use((req, res, next) => {
  getApp()
    .then((innerApp) => innerApp(req, res))
    .catch((err: unknown) => next(err));
});

export default app;

export async function startServer(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const port = Number.parseInt(process.env.PORT ?? "8080", 10);

  // Pre-build the inner app so config errors surface at startup.
  await getApp();

  app.listen(port, () => {
    logger.info(`api-gateway listening on port ${port}`);
  });
}

// Local dev / Render (`node dist/index.js`): start the listener.
// On Vercel the module is imported (require.main !== module), so this is skipped
// and the default-exported app is served instead.
if (require.main === module) {
  startServer().catch((err: unknown) => {
    console.error("Failed to start api-gateway:", err);
    process.exit(1);
  });
}
