import type { Request, Response, NextFunction } from "express";
import { isTradityPath } from "../config/route-map";

export function tradityGoneMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isTradityPath(req.path)) {
    res.status(410).json({
      status: false,
      msg: "This endpoint has been removed",
    });
    return;
  }
  next();
}
