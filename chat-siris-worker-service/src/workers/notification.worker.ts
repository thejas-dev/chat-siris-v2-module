import { Worker, type Job } from "bullmq";
import { createLogger, withWorkerSpan } from "@chat-siris/logger";
import { getBullConnectionOptions } from "./connection";
import { attachDlqOnFinalFailure } from "./dlq-handler";

const logger = createLogger(process.env.SERVICE_NAME ?? "worker-service");

export type NotificationJob = {
  messageId: string;
  channelName: string;
  senderId: string;
  senderName: string;
  previewText: string;
  memberIds?: string[];
  requestId?: string;
};

let worker: Worker<NotificationJob> | null = null;

async function processNotification(job: Job<NotificationJob>): Promise<void> {
  await withWorkerSpan(
    {
      queueName: "notification-queue",
      jobId: job.id,
      requestId: job.data.requestId,
    },
    async () => {
      logger.info("notification-queue stub", {
        messageId: job.data.messageId,
        channelName: job.data.channelName,
        requestId: job.data.requestId,
        jobId: job.id,
      });
    },
  );
}

export async function startNotificationWorker(): Promise<void> {
  worker = new Worker<NotificationJob>(
    "notification-queue",
    processNotification,
    { connection: getBullConnectionOptions() },
  );

  attachDlqOnFinalFailure(worker, "notification-queue");
}

export async function stopNotificationWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
