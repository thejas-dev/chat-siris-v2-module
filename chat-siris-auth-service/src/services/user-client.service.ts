import { signInternalRequest } from "@chat-siris/logger";

export type Profile = {
  _id: string;
  username: string;
  avatarImage: string;
  isAvatarImageSet: boolean;
  backgroundImage: string;
  admin: string;
  inChannel: string;
  createdAt: Date;
  updatedAt: Date;
};

export type Identity = {
  _id: string;
  email: string;
  googleSub?: string;
};

export type MergedUser = {
  _id: string;
  username: string;
  email: string;
  avatarImage: string;
  isAvatarImageSet: boolean;
  backgroundImage: string;
  admin: string;
  inChannel: string;
};

export type CreateProfilePayload = {
  _id: string;
  username: string;
  avatarImage: string;
  isAvatarImageSet: boolean;
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

export class UserServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    message?: string,
  ) {
    super(message ?? `user-service returned ${status}`);
    this.name = "UserServiceError";
  }
}

async function userServiceFetch(
  path: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(`${userServiceUrl()}${path}`, init);
  } catch {
    throw new UserServiceError(
      503,
      undefined,
      "user-service unreachable",
    );
  }
}

export async function fetchProfile(userId: string): Promise<Profile> {
  const path = `/internal/users/${userId}`;
  const res = await userServiceFetch(path, {
    method: "GET",
    headers: signedHeaders("GET", path),
  });

  if (!res.ok) {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: string } };
      code = body.error?.code;
    } catch {
      /* ignore */
    }
    throw new UserServiceError(res.status, code, `fetchProfile failed: ${res.status}`);
  }

  return (await res.json()) as Profile;
}

export async function createProfile(
  payload: CreateProfilePayload,
): Promise<Profile> {
  const path = "/internal/users";
  const res = await userServiceFetch(path, {
    method: "POST",
    headers: signedHeaders("POST", path),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: { code?: string } };
      code = body.error?.code;
    } catch {
      /* ignore */
    }
    throw new UserServiceError(res.status, code, `createProfile failed: ${res.status}`);
  }

  return (await res.json()) as Profile;
}

export function mergeUser(identity: Identity, profile: Profile): MergedUser {
  return {
    _id: profile._id,
    username: profile.username,
    email: identity.email,
    avatarImage: profile.avatarImage,
    isAvatarImageSet: profile.isAvatarImageSet,
    backgroundImage: profile.backgroundImage,
    admin: profile.admin,
    inChannel: profile.inChannel,
  };
}
