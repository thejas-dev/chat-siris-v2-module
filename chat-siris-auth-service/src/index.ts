import express, { type Express } from "express";
import cookieParser from "cookie-parser";
import mongoose from "mongoose";
import * as Sentry from "@sentry/node";
import {
  createLogger,
  requestContextMiddleware,
  buildHealthResponse,
} from "@chat-siris/logger";
import { createInternalRouter } from "./routes/internal.routes";
import { pingRedis } from "./redis";

require("dotenv").config();

const SERVICE_NAME = process.env.SERVICE_NAME ?? "auth-service";
const VERSION = process.env.npm_package_version ?? "1.0.0";

function initSentry(): void {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    return;
  }
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? "development",
    initialScope: {
      tags: { service: SERVICE_NAME, phase: "3" },
    },
  });
}

initSentry();

export { createRedisClient, getRedis, pingRedis, setRedisClient, resetRedisClient } from "./redis";

export async function createApp(): Promise<Express> {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use(requestContextMiddleware());

  const internalRouter = await createInternalRouter();
  app.use("/internal", internalRouter);

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

export async function connectMongo(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }

  const dbName = process.env.MONGODB_DB_NAME ?? "chat_auth";
  await mongoose.connect(uri, { dbName });
}

export async function pingMongo(): Promise<boolean> {
  return mongoose.connection.readyState === 1;
}

export async function startServer(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);

  await connectMongo();
  logger.info("Connected to MongoDB", {
    db: process.env.MONGODB_DB_NAME ?? "chat_auth",
  });

  const app = await createApp();

  app.get("/health", async (_req, res) => {
    const [mongoOk, redisOk] = await Promise.all([pingMongo(), pingRedis()]);

    const status = mongoOk && redisOk ? "ok" : "degraded";
    res.status(status === "ok" ? 200 : 503).json(
      buildHealthResponse({
        service: SERVICE_NAME,
        version: VERSION,
        mongo: mongoOk,
        redis: redisOk,
      }),
    );
  });

  app.listen(port, () => {
    logger.info(`auth-service listening on port ${port}`);
  });
}

if (require.main === module) {
  require("./telemetry");
  startServer().catch((err: unknown) => {
    console.error("Failed to start auth-service:", err);
    process.exit(1);
  });
}
