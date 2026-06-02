import type { Request, Response, NextFunction } from "express";
import { verifyInternalRequestWithRotation } from "@chat-siris/logger";

export type InternalErrorBody = {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    traceId: string;
  };
};

export function getTraceId(req: Request): string {
  return req.logContext?.requestId ?? "unknown";
}

export function sendInternalError(
  req: Request,
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const body: InternalErrorBody = {
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      traceId: getTraceId(req),
    },
  };
  res.status(status).json(body);
}

export function sendLegacyError(
  res: Response,
  status: number,
  msg: string,
): void {
  res.status(status).json({ status: false, msg });
}

export function hmacMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const secret = process.env.INTERNAL_HMAC_SECRET;
  if (!secret) {
    sendInternalError(
      req,
      res,
      500,
      "CHAT5000001",
      "INTERNAL_HMAC_SECRET is not configured",
    );
    return;
  }

  const fullPath = `${req.baseUrl}${req.path}`;
  const valid = verifyInternalRequestWithRotation({
    method: req.method,
    path: fullPath,
    headers: req.headers,
  });

  if (!valid) {
    sendInternalError(
      req,
      res,
      401,
      "CHAT4010001",
      "Missing or invalid internal signature",
    );
    return;
  }

  next();
}

export function gatewayMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  hmacMiddleware(req, res, () => {
    const userId = req.headers["x-user-id"];
    if (typeof userId !== "string" || userId.length === 0) {
      sendLegacyError(res, 403, "Not authorized");
      return;
    }
    req.gatewayUserId = userId;
    next();
  });
}

declare global {
  namespace Express {
    interface Request {
      gatewayUserId?: string;
    }
  }
}

export function requireSelfOrAdmin(
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
