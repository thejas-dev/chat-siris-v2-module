import type { Request, Response, NextFunction } from "express";
import { v4 as uuidv4 } from "uuid";

const IDENTITY_HEADERS = [
  "x-user-id",
  "x-user-email",
  "x-user-role",
  "x-auth-jti",
  "x-internal-signature",
  "x-internal-timestamp",
] as const;

export function stripClientIdentityHeaders(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  for (const header of IDENTITY_HEADERS) {
    delete req.headers[header];
  }
  next();
}

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const existing = req.headers["x-request-id"];
  const requestId =
    typeof existing === "string" && existing.length > 0 ? existing : uuidv4();

  req.headers["x-request-id"] = requestId;
  if (req.logContext) {
    req.logContext.requestId = requestId;
  } else {
    req.logContext = { requestId };
  }

  res.setHeader("X-Request-Id", requestId);
  next();
}
