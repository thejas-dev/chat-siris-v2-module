import { Queue } from "bullmq";
import { createLogger } from "@chat-siris/logger";
import { getBullMqConnection } from "../redis";

const logger = createLogger(process.env.SERVICE_NAME ?? "message-service");

export type NotificationJob = {
  messageId: string;
  channelName: string;
  senderId: string;
  senderName: string;
  previewText: string;
  requestId?: string;
};

let queue: Queue | null = null;

export function getNotificationQueue(): Queue {
  if (!queue) {
    queue = new Queue("notification-queue", {
      connection: {
        ...getBullMqConnection(),
        maxRetriesPerRequest: null,
      },
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }
  return queue;
}

export function notificationJobId(messageId: string): string {
  // BullMQ custom job IDs cannot contain ":" — messageId alone is sufficient
  return messageId;
}

export async function enqueueNotification(job: NotificationJob): Promise<void> {
  try {
    const q = getNotificationQueue();
    await q.add("notify", job, {
      jobId: notificationJobId(job.messageId),
    });

    logger.info("notification-queue enqueued", {
      messageId: job.messageId,
      channelName: job.channelName,
      requestId: job.requestId,
    });
  } catch (err) {
    logger.warn("notification-queue enqueue failed", {
      messageId: job.messageId,
      channelName: job.channelName,
      requestId: job.requestId,
      error: err instanceof Error ? err.message : "unknown error",
    });
  }
}

export async function closeNotificationQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
