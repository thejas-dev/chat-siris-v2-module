import { Queue } from "bullmq";
import { createLogger } from "@chat-siris/logger";
import { getBullMqConnection } from "../redis";

const logger = createLogger(process.env.SERVICE_NAME ?? "media-service");

export type MediaJob = {
  messageId?: string;
  uploadId: string;
  sourceUrl: string;
  mimeType: string;
  targetFolder: string;
  userId: string;
  requestId?: string;
};

let queue: Queue | null = null;

export function getMediaQueue(): Queue {
  if (!queue) {
    queue = new Queue("media-queue", {
      connection: {
        ...getBullMqConnection(),
        maxRetriesPerRequest: null,
      },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 10000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }
  return queue;
}

export function mediaJobId(uploadId: string): string {
  return uploadId;
}

export async function enqueueMediaJob(job: MediaJob): Promise<void> {
  try {
    const q = getMediaQueue();
    await q.add("process-media", job, {
      jobId: mediaJobId(job.uploadId),
    });

    logger.info("media-queue enqueued", {
      uploadId: job.uploadId,
      userId: job.userId,
      requestId: job.requestId,
    });
  } catch (err) {
    logger.warn("media-queue enqueue failed", {
      uploadId: job.uploadId,
      userId: job.userId,
      requestId: job.requestId,
      error: err instanceof Error ? err.message : "unknown error",
    });
  }
}

export async function closeMediaQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
