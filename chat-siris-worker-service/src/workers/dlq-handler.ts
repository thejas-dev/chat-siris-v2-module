import type { Job, Worker } from "bullmq";
import { moveToDlq } from "../services/dlq.service";
import { captureWorkerFailure } from "../services/sentry.service";

export function attachDlqOnFinalFailure<T>(
  worker: Worker<T>,
  queueName: string,
): void {
  worker.on("failed", (job: Job<T> | undefined, err: Error) => {
    if (!job) {
      return;
    }

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    captureWorkerFailure(queueName, err, {
      jobId: job.id,
      requestId: (job.data as { requestId?: string }).requestId,
    });

    void moveToDlq(queueName, job.name ?? "failed", job.data, err.message);
  });
}
