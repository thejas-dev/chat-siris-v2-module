import { Queue } from "bullmq";
import { buildBullMqConnection, createLogger } from "@chat-siris/logger";

const logger = createLogger(process.env.SERVICE_NAME ?? "group-service");

export type ChannelSyncJob = {
  userId: string;
  channelName: string;
  action: "join" | "leave";
  requestId?: string;
};

let queue: Queue | null = null;

function getBullConnectionOptions(): ReturnType<typeof buildBullMqConnection> & {
  maxRetriesPerRequest: null;
} {
  return {
    ...buildBullMqConnection(),
    maxRetriesPerRequest: null,
  };
}

export function channelSyncIdempotencyKey(job: ChannelSyncJob): string {
  return `${job.userId}:${job.channelName}:${job.action}`;
}

export function getChannelSyncQueue(): Queue {
  if (!queue) {
    queue = new Queue("channel-sync-queue", {
      connection: getBullConnectionOptions(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    });
  }
  return queue;
}

export async function enqueueChannelSync(job: ChannelSyncJob): Promise<void> {
  const q = getChannelSyncQueue();
  const jobId = channelSyncIdempotencyKey(job);
  const existing = await q.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "failed" || state === "completed") {
      await existing.remove();
    }
  }

  await q.add("sync-in-channel", job, { jobId });

  logger.info("channel-sync enqueued", {
    jobId,
    userId: job.userId,
    channelName: job.channelName,
    action: job.action,
    requestId: job.requestId,
  });
}

export async function closeChannelSyncQueue(): Promise<void> {
  if (queue) {
    await queue.close();
    queue = null;
  }
}
