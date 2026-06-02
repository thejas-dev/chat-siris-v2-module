import { signInternalRequest } from "@chat-siris/logger";

export type AuthorizeResponse = {
  allowed: boolean;
  reason?: string;
};

export type AuthorizeOutcome =
  | { status: "ok"; response: AuthorizeResponse }
  | { status: "denied"; response: AuthorizeResponse }
  | { status: "not_found" }
  | { status: "unavailable" };

const AUTHORIZE_TIMEOUT_MS = Number.parseInt(
  process.env.GROUP_SERVICE_TIMEOUT_MS ?? "5000",
  10,
);

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

function signedHeaders(
  method: string,
  path: string,
  requestId?: string,
  userId?: string,
): Record<string, string> {
  const { signature, timestamp } = signInternalRequest(
    method,
    path,
    hmacSecret(),
  );
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Internal-Signature": signature,
    "X-Internal-Timestamp": String(timestamp),
  };
  if (requestId) {
    headers["X-Request-Id"] = requestId;
  }
  if (userId) {
    headers["X-User-Id"] = userId;
  }
  return headers;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTHORIZE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveChannelId(
  channelName: string,
  userId: string,
  requestId?: string,
): Promise<string | null> {
  const path = "/internal/channels/lookup";
  try {
    const res = await fetchWithTimeout(`${groupServiceUrl()}${path}`, {
      method: "POST",
      headers: signedHeaders("POST", path, requestId, userId),
      body: JSON.stringify({ name: channelName }),
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      return null;
    }

    const body = (await res.json()) as {
      status?: boolean;
      data?: { _id?: string };
    };
    return body.data?._id ?? null;
  } catch {
    return null;
  }
}

async function callAuthorize(
  channelId: string,
  userId: string,
  action: "send" | "delete",
  requestId?: string,
): Promise<AuthorizeOutcome> {
  const path = `/internal/channels/${channelId}/authorize`;
  const query = new URLSearchParams({ userId, action });
  const requestUrl = `${groupServiceUrl()}${path}?${query.toString()}`;

  try {
    const res = await fetchWithTimeout(requestUrl, {
      method: "GET",
      // HMAC path must exclude query string — group-service verifies req.path only
      headers: signedHeaders("GET", path, requestId),
    });

    if (res.status === 404) {
      return { status: "not_found" };
    }

    if (res.status >= 500 || res.status === 408) {
      return { status: "unavailable" };
    }

    if (!res.ok) {
      return { status: "unavailable" };
    }

    const response = (await res.json()) as AuthorizeResponse;
    if (response.allowed) {
      return { status: "ok", response };
    }
    return { status: "denied", response };
  } catch {
    return { status: "unavailable" };
  }
}

async function authorizeAction(
  userId: string,
  channelName: string,
  action: "send" | "delete",
  requestId?: string,
): Promise<AuthorizeOutcome> {
  const channelId = await resolveChannelId(channelName, userId, requestId);
  if (!channelId) {
    return { status: "not_found" };
  }
  return callAuthorize(channelId, userId, action, requestId);
}

export async function authorizeSend(
  userId: string,
  channelName: string,
  requestId?: string,
): Promise<AuthorizeOutcome> {
  return authorizeAction(userId, channelName, "send", requestId);
}

export async function authorizeDelete(
  userId: string,
  channelName: string,
  requestId?: string,
): Promise<AuthorizeOutcome> {
  return authorizeAction(userId, channelName, "delete", requestId);
}

export async function channelExists(
  channelName: string,
  userId: string,
  requestId?: string,
): Promise<boolean | "unavailable"> {
  try {
    const channelId = await resolveChannelId(channelName, userId, requestId);
    if (channelId) {
      return true;
    }
    return false;
  } catch {
    return "unavailable";
  }
}
