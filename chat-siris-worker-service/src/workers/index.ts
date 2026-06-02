import { startChannelSyncWorker, stopChannelSyncWorker } from "./channel-sync.worker";
import { startNotificationWorker, stopNotificationWorker } from "./notification.worker";
import { startMediaWorker, stopMediaWorker } from "./media.worker";
import { startReadReceiptWorker, stopReadReceiptWorker } from "./read-receipt.worker";
import { closeDlqQueues } from "../services/dlq.service";
import { Queue } from "bullmq";
import { getBullMqConnection } from "../redis";

const QUEUE_NAMES = [
  "notification-queue",
  "media-queue",
  "read-receipt-queue",
  "channel-sync-queue",
] as const;

const lagThreshold = (): number =>
  Number.parseInt(process.env.QUEUE_LAG_THRESHOLD ?? "1000", 10);

export async function getQueueDepths(): Promise<Record<string, number>> {
  const depths: Record<string, number> = {};
  const connection = {
    ...getBullMqConnection(),
    maxRetriesPerRequest: null,
  };

  await Promise.all(
    QUEUE_NAMES.map(async (name) => {
      const queue = new Queue(name, { connection });
      try {
        const counts = await queue.getJobCounts("waiting", "delayed", "active");
        depths[name] =
          (counts.waiting ?? 0) + (counts.delayed ?? 0) + (counts.active ?? 0);
      } finally {
        await queue.close();
      }
    }),
  );

  return depths;
}

export function isQueueLagDegraded(depths: Record<string, number>): boolean {
  const threshold = lagThreshold();
  return Object.values(depths).some((count) => count > threshold);
}

export async function startWorkers(): Promise<void> {
  await Promise.all([
    startNotificationWorker(),
    startMediaWorker(),
    startReadReceiptWorker(),
    startChannelSyncWorker(),
  ]);
}

export async function stopWorkers(): Promise<void> {
  await Promise.all([
    stopNotificationWorker(),
    stopMediaWorker(),
    stopReadReceiptWorker(),
    stopChannelSyncWorker(),
    closeDlqQueues(),
  ]);
}
