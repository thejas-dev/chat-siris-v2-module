import { Worker, type Job } from "bullmq";
import { createLogger, withWorkerSpan } from "@chat-siris/logger";
import { getBullConnectionOptions } from "./connection";
import { attachDlqOnFinalFailure } from "./dlq-handler";

const logger = createLogger(process.env.SERVICE_NAME ?? "worker-service");

export type MediaJob = {
  messageId?: string;
  uploadId: string;
  sourceUrl: string;
  mimeType: string;
  targetFolder: string;
  userId: string;
  requestId?: string;
};

let worker: Worker<MediaJob> | null = null;

async function processMedia(job: Job<MediaJob>): Promise<void> {
  await withWorkerSpan(
    {
      queueName: "media-queue",
      jobId: job.id,
      requestId: job.data.requestId,
    },
    async () => processMediaJob(job),
  );
}

async function processMediaJob(job: Job<MediaJob>): Promise<void> {
  logger.info("media-queue processing", {
    uploadId: job.data.uploadId,
    messageId: job.data.messageId,
    requestId: job.data.requestId,
    jobId: job.id,
    attempt: job.attemptsMade + 1,
  });

  if (process.env.MEDIA_WORKER_SIMULATE_FAILURE === "true") {
    throw new Error(`Simulated media processing failure for ${job.data.uploadId}`);
  }
}

export async function startMediaWorker(): Promise<void> {
  worker = new Worker<MediaJob>(
    "media-queue",
    processMedia,
    {
      connection: getBullConnectionOptions(),
      settings: {
        backoffStrategy: () => 10000,
      },
    },
  );

  attachDlqOnFinalFailure(worker, "media-queue");
}

export async function stopMediaWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
