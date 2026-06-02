import { buildHealthResponse } from "@chat-siris/logger";
import {
  startWorkers,
  stopWorkers,
  getQueueDepths,
  isQueueLagDegraded,
} from "./workers/index";
import { pingCacheRedis, pingEventsRedis } from "./redis";

require("dotenv").config();

const SERVICE_NAME = process.env.SERVICE_NAME ?? "worker-service";
const VERSION = process.env.npm_package_version ?? "1.0.0";
const WORKER_DRAIN_MS = Number.parseInt(process.env.SIGTERM_DRAIN_MS ?? "60000", 10);

export {
  startWorkers,
  stopWorkers,
  getQueueDepths,
  isQueueLagDegraded,
} from "./workers/index";
export {
  getCacheRedis,
  setCacheRedisClient,
  resetCacheRedisClient,
  markIdempotent,
  isChannelSyncProcessed,
  markChannelSyncProcessed,
  idempotencyKey,
  getBullMqConnection,
} from "./redis";

export async function pingRedis(): Promise<boolean> {
  const [cacheOk, eventsOk] = await Promise.all([
    pingCacheRedis(),
    pingEventsRedis(),
  ]);
  return cacheOk && eventsOk;
}

export async function startServer(): Promise<void> {
  await startWorkers();

  const port = Number.parseInt(process.env.PORT ?? "3006", 10);
  const http = await import("http");

  const server = http.createServer(async (_req, res) => {
    const url = _req.url ?? "/";
    const redisOk = await pingRedis();
    const depths = await getQueueDepths();
    const lagDegraded = isQueueLagDegraded(depths);
    const status = redisOk && !lagDegraded ? "ok" : "degraded";

    if (url === "/health/queues") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ queues: depths, threshold: process.env.QUEUE_LAG_THRESHOLD ?? "1000" }));
      return;
    }

    res.writeHead(status === "ok" ? 200 : 503, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify({
        ...buildHealthResponse({
          service: SERVICE_NAME,
          version: VERSION,
          redis: redisOk,
        }),
        status,
        queues: depths,
      }),
    );
  });

  server.listen(port, () => {
    console.log(`worker-service listening on port ${port}`);
  });

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`${signal} received — draining workers (${WORKER_DRAIN_MS}ms max)`);

    const drainTimeout = setTimeout(() => {
      console.warn("Worker drain timeout — forcing exit");
      process.exit(0);
    }, WORKER_DRAIN_MS);

    await stopWorkers();
    server.close(() => {
      clearTimeout(drainTimeout);
      process.exit(0);
    });
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
    console.error("Failed to start worker-service:", err);
    process.exit(1);
  });
}
