import { signInternalRequest } from "@chat-siris/logger";

export type ChannelLookup = {
  _id: string;
  name: string;
  users: Array<{ _id: string }>;
};

function groupServiceUrl(): string {
  const url = process.env.GROUP_SERVICE_URL;
  if (!url) {
    throw new Error("GROUP_SERVICE_URL is required");
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

function signedGatewayHeaders(
  method: string,
  path: string,
  userId: string,
): Record<string, string> {
  const { signature, timestamp } = signInternalRequest(method, path, hmacSecret());
  return {
    "Content-Type": "application/json",
    "X-Internal-Signature": signature,
    "X-Internal-Timestamp": String(timestamp),
    "X-User-Id": userId,
  };
}

const LOOKUP_TIMEOUT_MS = Number.parseInt(
  process.env.GROUP_SERVICE_TIMEOUT_MS ?? "5000",
  10,
);

export async function lookupChannelByName(
  channelName: string,
  userId: string,
): Promise<ChannelLookup | null | "unavailable"> {
  const path = "/internal/channels/lookup";

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

    const res = await fetch(`${groupServiceUrl()}${path}`, {
      method: "POST",
      headers: signedGatewayHeaders("POST", path, userId),
      body: JSON.stringify({ name: channelName }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      return "unavailable";
    }

    const body = (await res.json()) as {
      status?: boolean;
      data?: ChannelLookup;
    };

    if (!body.status || !body.data?._id) {
      return null;
    }

    return body.data;
  } catch {
    return "unavailable";
  }
}
