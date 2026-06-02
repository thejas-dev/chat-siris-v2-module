import { Worker, type Job } from "bullmq";
import { createLogger, withWorkerSpan } from "@chat-siris/logger";
import {
  channelSyncIdempotencyKey,
  syncInChannel,
  type ChannelSyncJob,
} from "../services/user-client.service";
import {
  isChannelSyncProcessed,
  markChannelSyncProcessed,
} from "../redis";
import { getBullConnectionOptions } from "./connection";
import { attachDlqOnFinalFailure } from "./dlq-handler";

const logger = createLogger(process.env.SERVICE_NAME ?? "worker-service");

let channelSyncWorker: Worker<ChannelSyncJob> | null = null;

async function processChannelSync(job: Job<ChannelSyncJob>): Promise<void> {
  await withWorkerSpan(
    {
      queueName: "channel-sync-queue",
      jobId: job.id,
      requestId: job.data.requestId,
    },
    async () => processChannelSyncJob(job),
  );
}

async function processChannelSyncJob(job: Job<ChannelSyncJob>): Promise<void> {
  const idempotencyKey = channelSyncIdempotencyKey(job.data);
  if (await isChannelSyncProcessed(idempotencyKey)) {
    logger.info("channel-sync duplicate skipped", {
      jobId: job.id,
      idempotencyKey,
      requestId: job.data.requestId,
    });
    return;
  }

  logger.info("channel-sync processing", {
    jobId: job.id,
    userId: job.data.userId,
    channelName: job.data.channelName,
    action: job.data.action,
    attempt: job.attemptsMade + 1,
    requestId: job.data.requestId,
  });

  const ok = await syncInChannel(job.data);
  if (!ok) {
    throw new Error(`channel-sync failed for ${idempotencyKey}`);
  }

  await markChannelSyncProcessed(idempotencyKey);

  logger.info("channel-sync completed", {
    jobId: job.id,
    userId: job.data.userId,
    channelName: job.data.channelName,
    action: job.data.action,
    requestId: job.data.requestId,
  });
}

export async function startChannelSyncWorker(): Promise<void> {
  channelSyncWorker = new Worker<ChannelSyncJob>(
    "channel-sync-queue",
    processChannelSync,
    { connection: getBullConnectionOptions() },
  );

  attachDlqOnFinalFailure(channelSyncWorker, "channel-sync-queue");

  channelSyncWorker.on("failed", (job, err) => {
    logger.error("channel-sync job failed", {
      jobId: job?.id,
      error: err.message,
      requestId: job?.data.requestId,
    });
  });
}

export async function stopChannelSyncWorker(): Promise<void> {
  if (channelSyncWorker) {
    await channelSyncWorker.close();
    channelSyncWorker = null;
  }
}
