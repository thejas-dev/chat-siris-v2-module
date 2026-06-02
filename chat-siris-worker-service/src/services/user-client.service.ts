import { signInternalRequest } from "@chat-siris/logger";

export type ChannelSyncJob = {
  userId: string;
  channelName: string;
  action: "join" | "leave";
  requestId?: string;
};

function userServiceUrl(): string {
  const url = process.env.USER_SERVICE_URL;
  if (!url) {
    throw new Error("USER_SERVICE_URL is required");
  }
  return url.replace(/\/$/, "");
}

function hmacSecret(): string {
  const secret = process.env.INTERNAL_HMAC_SECRET;
  if (!secret) {
    throw new Error("INTERNAL_HMAC_SECRET is required");
  }
  return secret;
}

function signedHeaders(method: string, path: string): Record<string, string> {
  const { signature, timestamp } = signInternalRequest(
    method,
    path,
    hmacSecret(),
  );
  return {
    "Content-Type": "application/json",
    "X-Internal-Signature": signature,
    "X-Internal-Timestamp": String(timestamp),
  };
}

export function channelSyncIdempotencyKey(job: ChannelSyncJob): string {
  return `${job.userId}:${job.channelName}:${job.action}`;
}

export async function syncInChannel(job: ChannelSyncJob): Promise<boolean> {
  const inChannel = job.action === "join" ? job.channelName : "";
  const path = `/internal/users/${job.userId}/channel-pointer`;
  const headers = signedHeaders("POST", path);
  if (job.requestId) {
    headers["X-Request-Id"] = job.requestId;
  }

  try {
    const res = await fetch(`${userServiceUrl()}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ inChannel }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
