import type { Request } from "express";
import { signInternalRequest, injectTraceHeaders } from "@chat-siris/logger";
import type { AuthClaims } from "./jwt.middleware";

export function injectInternalHeaders(
  req: Request,
  targetPath: string,
  claims?: AuthClaims,
): Record<string, string> {
  const secret = process.env.INTERNAL_HMAC_SECRET;
  if (!secret) {
    throw new Error("INTERNAL_HMAC_SECRET is required");
  }

  const requestId =
    req.logContext?.requestId ??
    (typeof req.headers["x-request-id"] === "string"
      ? req.headers["x-request-id"]
      : "");

  const headers: Record<string, string> = {
    "X-Request-Id": requestId,
  };

  if (claims) {
    headers["X-User-Id"] = claims.userId;
    headers["X-User-Email"] = claims.email;
    headers["X-User-Role"] = claims.role;
    headers["X-Auth-Jti"] = claims.jti;
  }

  const { signature, timestamp } = signInternalRequest(
    req.method,
    targetPath,
    secret,
  );
  headers["X-Internal-Signature"] = signature;
  headers["X-Internal-Timestamp"] = String(timestamp);

  injectTraceHeaders(headers);

  return headers;
}
