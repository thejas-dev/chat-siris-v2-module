import express, { type Express } from "express";
import mongoose from "mongoose";
import {
  createLogger,
  requestContextMiddleware,
  buildHealthResponse,
} from "@chat-siris/logger";
import { internalRouter } from "./routes/internal.routes";
import { pingRedis } from "./redis";
import { startChannelEventSubscriber } from "./services/channel-events.subscriber";
require("dotenv").config();

export { createRedisClient, getRedis, pingRedis, setRedisClient, resetRedisClient } from "./redis";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "user-service";
const VERSION = process.env.npm_package_version ?? "1.0.0";

export function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(requestContextMiddleware());
  app.use("/internal", internalRouter);
  return app;
}

export async function connectMongo(): Promise<void> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is required");
  }

  const dbName = process.env.MONGODB_DB_NAME ?? "chat_users";
  await mongoose.connect(uri, { dbName });
}

export async function pingMongo(): Promise<boolean> {
  return mongoose.connection.readyState === 1;
}

export async function startServer(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const port = Number.parseInt(process.env.PORT ?? "3002", 10);

  await connectMongo();
  logger.info("Connected to MongoDB", {
    db: process.env.MONGODB_DB_NAME ?? "chat_users",
  });

  try {
    await startChannelEventSubscriber();
  } catch (err: unknown) {
    logger.warn("channel_subscriber_degraded", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const app = createApp();

  app.get("/health", async (_req, res) => {
    const [mongoOk, redisOk] = await Promise.all([
      pingMongo(),
      pingRedis(),
    ]);

    res.json(
      buildHealthResponse({
        service: SERVICE_NAME,
        version: VERSION,
        mongo: mongoOk,
        redis: redisOk,
      }),
    );
  });

  app.listen(port, () => {
    logger.info(`user-service listening on port ${port}`);
  });
}

if (require.main === module) {
  require("./telemetry");
  startServer().catch((err: unknown) => {
    console.error("Failed to start user-service:", err);
    process.exit(1);
  });
}
