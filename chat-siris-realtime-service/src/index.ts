import http from "http";
import path from "path";
import express from "express";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import {
  buildHealthResponse,
  createLogger,
} from "@chat-siris/logger";
import { checkConnectRateLimit } from "./middleware/connect-rate-limit.middleware";
import { socketAuthMiddleware } from "./middleware/socket-auth.middleware";
import { registerSocketHandlers } from "./socket/register-handlers";
import { subscribeAllEvents, unsubscribeAllEvents } from "./subscribers/index";
import { buildCorsOriginChecker } from "./cors";
import {
  getCacheRedis,
  getEventsRedis,
  getEventsSubscriber,
  pingCacheRedis,
  pingEventsRedis,
  resetRedisClients,
} from "./redis";

require("dotenv").config();

export {
  createCacheRedisClient,
  createEventsRedisClient,
  getCacheRedis,
  getEventsRedis,
  getEventsSubscriber,
  setCacheRedisClient,
  setEventsRedisClient,
  setEventsSubscriberClient,
  resetRedisClients,
  pingCacheRedis,
  pingEventsRedis,
} from "./redis";

export { socketAuthMiddleware } from "./middleware/socket-auth.middleware";
export {
  subscribeAllEvents,
  unsubscribeAllEvents,
  subscribeAllEvents as subscribeMessageEvents,
} from "./subscribers/index";
export { handleAddUser } from "./handlers/presence.handler";

const SERVICE_NAME = process.env.SERVICE_NAME ?? "realtime-service";
const VERSION = process.env.npm_package_version ?? "1.0.0";
const DRAIN_MS = Number.parseInt(process.env.SIGTERM_DRAIN_MS ?? "30000", 10);

let ioServer: Server | null = null;
let httpServer: http.Server | null = null;
let shuttingDown = false;

export function getIoServer(): Server | null {
  return ioServer;
}

export async function createSocketServer(
  server: http.Server,
): Promise<Server> {
  const logger = createLogger(SERVICE_NAME);
  const io = new Server(server, {
    cors: {
      origin: buildCorsOriginChecker(),
      methods: ["GET", "POST"],
      allowedHeaders: ["my-custom-header"],
      credentials: true,
    },
    allowRequest: async (req, callback) => {
      if (shuttingDown) {
        callback("Server is shutting down", false);
        return;
      }

      const allowed = await checkConnectRateLimit({
        address: req.socket.remoteAddress,
        headers: req.headers as Record<string, string | string[] | undefined>,
      });

      if (!allowed) {
        callback("Too many connection attempts", false);
        return;
      }

      callback(null, true);
    },
  });

  if (process.env.SKIP_SOCKET_REDIS_ADAPTER !== "true") {
    const pubClient = await getEventsRedis();
    const subClient = pubClient.duplicate();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));
  }

  io.use(socketAuthMiddleware);

  io.engine.on("connection_error", (err) => {
    logger.warn("socket engine connection_error", {
      code: err.code,
      message: err.message,
      context: err.context,
    });
  });

  io.on("connection", (socket) => {
    logger.info("socket connected", {
      socketId: socket.id,
      userId: socket.data.userId,
      totalConnections: io.engine.clientsCount,
    });
    registerSocketHandlers(io, socket);
  });

  const subscriber = await getEventsSubscriber();
  await subscribeAllEvents(io, subscriber);

  ioServer = io;
  return io;
}

export function createHealthApp(): express.Express {
  const app = express();
  const testClientDir = path.join(__dirname, "..", "test-client");

  app.use("/test-client", express.static(testClientDir));
  app.get("/test-client", (_req, res) => {
    res.redirect("/test-client/");
  });

  app.get("/health", async (_req, res) => {
    const [cacheOk, eventsOk] = await Promise.all([
      pingCacheRedis(),
      pingEventsRedis(),
    ]);
    const redisOk = cacheOk && eventsOk;
    const status = redisOk ? "ok" : "degraded";
    res.status(status === "ok" ? 200 : 503).json(
      buildHealthResponse({
        service: SERVICE_NAME,
        version: VERSION,
        redis: redisOk,
      }),
    );
  });
  return app;
}

export async function startServer(): Promise<void> {
  const logger = createLogger(SERVICE_NAME);
  const port = Number.parseInt(process.env.PORT ?? "3333", 10);

  await getCacheRedis();

  const app = createHealthApp();
  httpServer = http.createServer(app);

  await createSocketServer(httpServer);

  httpServer.listen(port, () => {
    logger.info(`realtime-service listening on port ${port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info(`${signal} received — draining connections`, { drainMs: DRAIN_MS });

    if (ioServer) {
      ioServer.emit("server-shutdown", { message: "Server restarting" });
      ioServer.close();
    }

    const drainTimeout = setTimeout(() => {
      logger.warn("Drain timeout exceeded — forcing exit");
      process.exit(0);
    }, DRAIN_MS);

    try {
      const subscriber = await getEventsSubscriber();
      await unsubscribeAllEvents(subscriber);
      await resetRedisClients();
    } catch {
      /* best effort */
    }

    if (httpServer) {
      httpServer.close(() => {
        clearTimeout(drainTimeout);
        process.exit(0);
      });
    } else {
      clearTimeout(drainTimeout);
      process.exit(0);
    }
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

if (require.main === module) {
  require("./telemetry");
  startServer().catch((err: unknown) => {
    console.error("Failed to start realtime-service:", err);
    process.exit(1);
  });
}
