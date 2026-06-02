import { Queue } from "bullmq";
import { getBullMqConnection } from "../redis";

const dlqQueues = new Map<string, Queue>();

export function getDlqQueue(queueName: string): Queue {
  const dlqName = `${queueName}-dlq`;
  let queue = dlqQueues.get(dlqName);
  if (!queue) {
    queue = new Queue(dlqName, {
      connection: {
        ...getBullMqConnection(),
        maxRetriesPerRequest: null,
      },
    });
    dlqQueues.set(dlqName, queue);
  }
  return queue;
}

export async function moveToDlq(
  queueName: string,
  jobName: string,
  data: unknown,
  errorMessage: string,
): Promise<void> {
  const dlq = getDlqQueue(queueName);
  await dlq.add(jobName, {
    ...(typeof data === "object" && data !== null ? data : { payload: data }),
    dlqReason: errorMessage,
    failedAt: new Date().toISOString(),
  });
}

export async function closeDlqQueues(): Promise<void> {
  await Promise.all([...dlqQueues.values()].map((q) => q.close()));
  dlqQueues.clear();
}
