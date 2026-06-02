import type { Request, Response, NextFunction } from "express";
import { verifyInternalRequestWithRotation } from "@chat-siris/logger";

export function getGatewayUserId(req: Request): string | undefined {
  const userId = req.headers["x-user-id"];
  return typeof userId === "string" && userId.length > 0 ? userId : undefined;
}

export function sendLegacyError(
  res: Response,
  status: number,
  msg: string,
): void {
  res.status(status).json({ status: false, msg });
}

export function gatewayMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = process.env.INTERNAL_HMAC_SECRET;
  if (!secret) {
    res.status(500).json({
      error: {
        code: "CHAT5000001",
        message: "INTERNAL_HMAC_SECRET is not configured",
        traceId: req.logContext?.requestId ?? "unknown",
      },
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
      error: {
        code: "CHAT4010001",
        message: "Missing or invalid internal signature",
        traceId: req.logContext?.requestId ?? "unknown",
      },
    });
    return;
  }

  const userId = getGatewayUserId(req);
  if (!userId) {
    sendLegacyError(res, 403, "Not authorized");
    return;
  }

  req.gatewayUserId = userId;
  next();
}

declare global {
  namespace Express {
    interface Request {
      gatewayUserId?: string;
    }
  }
}

export function requireSelf(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const paramId = req.params.id;
  const id = Array.isArray(paramId) ? paramId[0] : paramId;
  if (!id || req.gatewayUserId !== id) {
    sendLegacyError(res, 403, "Not authorized");
    return;
  }
  next();
}
