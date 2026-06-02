import type { Request, Response, NextFunction } from "express";
import { verifyInternalRequestWithRotation } from "@chat-siris/logger";

export function getTraceId(req: Request): string {
  return req.logContext?.requestId ?? "unknown";
}

export function hmacMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = process.env.INTERNAL_HMAC_SECRET;
  if (!secret) {
    res.status(500).json({
      status: false,
      msg: "Service configuration error",
    });
    return;
  }

  const fullPath = `${req.baseUrl}${req.path}`;
  const valid = verifyInternalRequestWithRotation({
    method: req.method,
    path: fullPath,
    headers: req.headers,
  });

  if (!valid) {
    res.status(401).json({
      status: false,
      msg: "Authentication required",
    });
    return;
  }

  next();
}
