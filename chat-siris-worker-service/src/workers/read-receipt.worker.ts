import { Worker, type Job } from "bullmq";
import { createLogger } from "@chat-siris/logger";
import { getBullConnectionOptions } from "./connection";
import { attachDlqOnFinalFailure } from "./dlq-handler";

const logger = createLogger(process.env.SERVICE_NAME ?? "worker-service");

export type ReadReceiptJob = {
  userId: string;
  channelName: string;
  messageIds: string[];
  readAt: string;
  requestId?: string;
};

let worker: Worker<ReadReceiptJob> | null = null;

async function processReadReceipt(job: Job<ReadReceiptJob>): Promise<void> {
  logger.info("read-receipt-queue scaffold", {
    userId: job.data.userId,
    channelName: job.data.channelName,
    messageCount: job.data.messageIds.length,
    requestId: job.data.requestId,
    jobId: job.id,
  });
}

export async function startReadReceiptWorker(): Promise<void> {
  worker = new Worker<ReadReceiptJob>(
    "read-receipt-queue",
    processReadReceipt,
    { connection: getBullConnectionOptions() },
  );

  attachDlqOnFinalFailure(worker, "read-receipt-queue");
}

export async function stopReadReceiptWorker(): Promise<void> {
  if (worker) {
    await worker.close();
    worker = null;
  }
}
