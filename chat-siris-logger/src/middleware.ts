import type { NextFunction, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";

export interface LogContext {
  requestId: string;
  userId?: string;
}

declare global {
  namespace Express {
    interface Request {
      logContext: LogContext;
    }
  }
}

export function requestContextMiddleware(): (
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const headerRequestId = req.headers["x-request-id"];
    const requestId =
      typeof headerRequestId === "string" && headerRequestId.length > 0
        ? headerRequestId
        : uuidv4();

    const headerUserId = req.headers["x-user-id"];
    const userId =
      typeof headerUserId === "string" && headerUserId.length > 0
        ? headerUserId
        : undefined;

    req.logContext = userId ? { requestId, userId } : { requestId };
    next();
  };
}
