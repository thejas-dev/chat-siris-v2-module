import { createLogger } from "@chat-siris/logger";

const logger = createLogger(process.env.SERVICE_NAME ?? "worker-service");

export function captureWorkerFailure(
  queueName: string,
  err: Error,
  meta?: Record<string, unknown>,
): void {
  logger.error("worker job failed permanently", {
    queue: queueName,
    error: err.message,
    sentry: process.env.SENTRY_DSN ? "configured" : "disabled",
    ...meta,
  });
}
