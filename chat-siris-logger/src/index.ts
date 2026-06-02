import winston from "winston";
import LokiTransport from "winston-loki";
import type { Request } from "express";

require("dotenv").config();
export { requestContextMiddleware } from "./middleware";
export type { LogContext } from "./middleware";
export {
  signInternalRequest,
  verifyInternalRequest,
  getInternalHmacSecrets,
  verifyInternalRequestWithRotation,
} from "./internal-auth";
export type { InternalRequestLike } from "./internal-auth";
export {
  initTelemetry,
  shutdownTelemetry,
  injectTraceHeaders,
  withWorkerSpan,
} from "./telemetry";
export type { WorkerSpanOptions } from "./telemetry";
export { buildHealthResponse } from "./health";
export type { HealthResponse } from "./health";
export {
  resolveCacheRedisUrl,
  resolveEventsRedisUrl,
  resolveCacheDbIndex,
  resolveEventsDbIndex,
  isDualUrlMode,
  buildBullMqConnection,
} from "./redis-env";
export type { BullMqConnection } from "./redis-env";

let serviceLogger: winston.Logger | null = null;

export function createLogger(serviceName: string): winston.Logger {
  const transports: winston.transport[] = [];

  if (process.env.NODE_ENV === "development" || !process.env.LOKI_HOST) {
    transports.push(new winston.transports.Console());
  }

  if (process.env.LOKI_HOST) {
    const basicAuth =
      process.env.LOKI_USER && process.env.LOKI_API_KEY
        ? `${process.env.LOKI_USER}:${process.env.LOKI_API_KEY}`
        : undefined;

    transports.push(
      new LokiTransport({
        host: process.env.LOKI_HOST,
        basicAuth,
        labels: {
          app: "chat-app",
          service: serviceName,
          env: process.env.NODE_ENV ?? "development",
        },
        interval: 5,
        json: true,
      }),
    );
  }

  serviceLogger = winston.createLogger({
    level: process.env.LOG_LEVEL ?? "info",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.json(),
    ),
    defaultMeta: { service: serviceName },
    transports,
  });

  return serviceLogger;
}

export function logWithContext(
  req: Request,
  level: string,
  message: string,
  meta?: Record<string, unknown>,
): void {
  if (!serviceLogger) {
    throw new Error(
      "@chat-siris/logger: createLogger must be called before logWithContext",
    );
  }

  const context = req.logContext;
  const requestId =
    context?.requestId ??
    (typeof req.headers["x-request-id"] === "string"
      ? req.headers["x-request-id"]
      : undefined);
  const userId =
    context?.userId ??
    (typeof req.headers["x-user-id"] === "string"
      ? req.headers["x-user-id"]
      : undefined);

  serviceLogger.log(level, message, {
    requestId,
    ...(userId ? { userId } : {}),
    ...meta,
  });
}
