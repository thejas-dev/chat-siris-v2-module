// Load env first, then telemetry (so OpenTelemetry can instrument http/express
// before those modules are required), then everything else.
import "dotenv/config";
import "./telemetry";
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

// createApp() is async; build it once on first request and reuse it.
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
// (zero-config Express). /health stays connection-agnostic; all other paths ensure
// Mongo + the (async-built) inner app, then delegate to it.
const app = express();

app.get("/health", async (_req, res) => {
  const [mongoOk, redisOk] = await Promise.all([pingMongo(), pingRedis()]);
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

app.use((req, res, next) => {
  Promise.all([getApp(), ensureMongoConnection()])
    .then(([innerApp]) => innerApp(req, res))
    .catch((err: unknown) => next(err));
});

export default app;

export async function startServer(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const port = Number.parseInt(process.env.PORT ?? "3001", 10);

  await connectMongo();
  logger.info("Connected to MongoDB", {
    db: process.env.MONGODB_DB_NAME ?? "chat_auth",
  });

  // Pre-build the inner app so config/route errors surface at startup.
  await getApp();

  app.listen(port, () => {
    logger.info(`auth-service listening on port ${port}`);
  });
}

// Local dev / Render (`node dist/index.js`): start the listener.
// On Vercel the module is imported (require.main !== module), so this is skipped
// and the default-exported app is served instead.
if (require.main === module) {
  startServer().catch((err: unknown) => {
    console.error("Failed to start auth-service:", err);
    process.exit(1);
  });
}
