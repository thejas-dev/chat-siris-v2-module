import { signInternalRequest } from "@chat-siris/logger";

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

const HTTP_TIMEOUT_MS = Number.parseInt(
  process.env.USER_SERVICE_TIMEOUT_MS ?? "10000",
  10,
);

export async function syncInChannel(
  userId: string,
  inChannel: string,
  requestId?: string,
): Promise<boolean> {
  const path = `/internal/users/${userId}/channel-pointer`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

  try {
    const headers = signedHeaders("POST", path);
    if (requestId) {
      headers["X-Request-Id"] = requestId;
    }

    const res = await fetch(`${userServiceUrl()}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ inChannel }),
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
