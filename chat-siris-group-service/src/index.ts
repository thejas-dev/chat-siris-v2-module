// Load env first, then telemetry (so OpenTelemetry can instrument http/express
// before those modules are required), then everything else.
import "dotenv/config";
import "./telemetry";
import express, { type Express } from "express";
import mongoose from "mongoose";
import {
  createLogger,
  requestContextMiddleware,
  buildHealthResponse,
} from "@chat-siris/logger";
import { internalRouter } from "./routes/internal.routes";
import { pingCacheRedis } from "./redis";

export {
  createCacheRedisClient,
  createEventsRedisClient,
  getCacheRedis,
  getEventsRedis,
  setCacheRedisClient,
  setEventsRedisClient,
  resetRedisClients,
  pingCacheRedis,
} from "./redis";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "group-service";
const VERSION = process.env.npm_package_version ?? "1.0.0";

/** Core router app (json + request context + internal routes). Used by tests. */
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

  const dbName = process.env.MONGODB_DB_NAME ?? "chat_groups";
  await mongoose.connect(uri, { dbName });
}

export async function pingMongo(): Promise<boolean> {
  return mongoose.connection.readyState === 1;
}

// Serverless has no startup hook, so connect to Mongo lazily on first request and
// cache the promise across warm invocations. No-op once connected.
let mongoConnectPromise: Promise<void> | null = null;
function ensureMongoConnection(): Promise<void> {
  if (mongoose.connection.readyState === 1) {
    return Promise.resolve();
  }
  if (!mongoConnectPromise) {
    mongoConnectPromise = connectMongo().catch((err: unknown) => {
      mongoConnectPromise = null;
      throw err;
    });
  }
  return mongoConnectPromise;
}

// The full app used by both Vercel (default export) and the local/Render listener.
// /health stays connection-agnostic; everything after the guard ensures Mongo.
function buildApp(): Express {
  const app = express();

  app.get("/health", async (_req, res) => {
    const [mongoOk, redisOk] = await Promise.all([pingMongo(), pingCacheRedis()]);
    const ok = mongoOk && redisOk;
    res.status(ok ? 200 : 503).json(
      buildHealthResponse({
        service: SERVICE_NAME,
        version: VERSION,
        mongo: mongoOk,
        redis: redisOk,
      }),
    );
  });

  app.use((_req, _res, next) => {
    ensureMongoConnection()
      .then(() => next())
      .catch((err: unknown) => next(err));
  });

  app.use(createApp());
  return app;
}

const app = buildApp();

// Default export: Vercel auto-detects this Express app as a single Serverless
// Function (zero-config Express). Do NOT call app.listen() at module top for Vercel.
export default app;

export async function startServer(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const port = Number.parseInt(process.env.PORT ?? "3003", 10);

  await connectMongo();
  logger.info("Connected to MongoDB", {
    db: process.env.MONGODB_DB_NAME ?? "chat_groups",
  });

  app.listen(port, () => {
    logger.info(`group-service listening on port ${port}`);
  });
}

// Local dev / Render (`node dist/index.js`): start the listener.
// On Vercel the module is imported (require.main !== module), so this is skipped
// and the default-exported app is served instead.
if (require.main === module) {
  startServer().catch((err: unknown) => {
    console.error("Failed to start group-service:", err);
    process.exit(1);
  });
}
