import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { getRedis } from "../redis";
import { IdentityModel } from "../models/identity.model";

const ACCESS_TOKEN_TTL_SEC = 900;
const REFRESH_TOKEN_TTL_SEC = 604800;
const REFRESH_KEY_PREFIX = "chat:refresh:";

export type AccessTokenClaims = {
  sub: string;
  email: string;
  jti: string;
  iat: number;
  exp: number;
};

type RefreshPayload = {
  userId: string;
  deviceId: string;
};

function getPrivateKey(): string {
  const key = process.env.JWT_PRIVATE_KEY;
  if (!key) {
    throw new Error("JWT_PRIVATE_KEY is required");
  }
  return key.replace(/\\n/g, "\n");
}

function getPublicKey(): string {
  const key = process.env.JWT_PUBLIC_KEY;
  if (!key) {
    throw new Error("JWT_PUBLIC_KEY is required");
  }
  return key.replace(/\\n/g, "\n");
}

export function issueAccessToken(claims: {
  sub: string;
  email: string;
}): { token: string; jti: string; exp: number } {
  const jti = randomUUID();
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ACCESS_TOKEN_TTL_SEC;

  const token = jwt.sign(
    { sub: claims.sub, email: claims.email, jti },
    getPrivateKey(),
    { algorithm: "RS256", expiresIn: ACCESS_TOKEN_TTL_SEC },
  );

  return { token, jti, exp };
}

export function verifyAccessToken(token: string): AccessTokenClaims | null {
  try {
    const decoded = jwt.verify(token, getPublicKey(), {
      algorithms: ["RS256"],
    }) as jwt.JwtPayload;

    if (
      typeof decoded.sub !== "string" ||
      typeof decoded.email !== "string" ||
      typeof decoded.jti !== "string" ||
      typeof decoded.iat !== "number" ||
      typeof decoded.exp !== "number"
    ) {
      return null;
    }

    return {
      sub: decoded.sub,
      email: decoded.email,
      jti: decoded.jti,
      iat: decoded.iat,
      exp: decoded.exp,
    };
  } catch {
    return null;
  }
}

export async function issueRefreshToken(
  userId: string,
  deviceId = "",
): Promise<{ tokenId: string; cookieValue: string }> {
  const tokenId = randomUUID();
  const redis = await getRedis();
  const key = `${REFRESH_KEY_PREFIX}${tokenId}`;
  const payload: RefreshPayload = { userId, deviceId };

  await redis.set(key, JSON.stringify(payload), { EX: REFRESH_TOKEN_TTL_SEC });

  return { tokenId, cookieValue: tokenId };
}

export async function getRefreshPayload(
  tokenId: string,
): Promise<RefreshPayload | null> {
  const redis = await getRedis();
  const raw = await redis.get(`${REFRESH_KEY_PREFIX}${tokenId}`);
  if (!raw) {
    return null;
  }
  return JSON.parse(raw) as RefreshPayload;
}

export async function rotateRefreshToken(
  oldTokenId: string,
): Promise<{
  accessToken: string;
  refreshToken?: string;
  userId: string;
  email: string;
} | null> {
  const redis = await getRedis();
  const key = `${REFRESH_KEY_PREFIX}${oldTokenId}`;
  const raw = await redis.get(key);
  if (!raw) {
    return null;
  }

  const payload = JSON.parse(raw) as RefreshPayload;
  await redis.del(key);

  const identity = await IdentityModel.findById(payload.userId);
  if (!identity) {
    return null;
  }

  const { token: accessToken } = issueAccessToken({
    sub: identity._id.toString(),
    email: identity.email,
  });

  const { tokenId: refreshToken } = await issueRefreshToken(
    payload.userId,
    payload.deviceId,
  );

  return {
    accessToken,
    refreshToken,
    userId: payload.userId,
    email: identity.email,
  };
}

export async function revokeRefreshToken(tokenId: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(`${REFRESH_KEY_PREFIX}${tokenId}`);
}

export const REFRESH_COOKIE_NAME = "refreshToken";

export function refreshCookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  maxAge: number;
  path: string;
} {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: REFRESH_TOKEN_TTL_SEC * 1000,
    path: "/",
  };
}
