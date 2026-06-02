import type { Request, Response, NextFunction } from "express";
import { isJwtExempt } from "../config/route-map";
import { resolveAuthClaims } from "../services/auth-introspect.service";

export type AuthClaims = {
  userId: string;
  email: string;
  role: "user" | "admin";
  jti: string;
  exp: number;
};

declare global {
  namespace Express {
    interface Request {
      authClaims?: AuthClaims;
    }
  }
}

const UNAUTHORIZED_BODY = {
  status: false,
  msg: "Authentication required",
} as const;

export async function jwtMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (isJwtExempt(req.path)) {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json(UNAUTHORIZED_BODY);
    return;
  }

  const token = authHeader.slice(7);
  const claims = await resolveAuthClaims(token);

  if (!claims) {
    res.status(401).json(UNAUTHORIZED_BODY);
    return;
  }

  req.authClaims = {
    userId: claims.userId,
    email: claims.email,
    role: claims.roles.includes("admin") ? "admin" : "user",
    jti: claims.jti,
    exp: claims.exp,
  };

  if (req.logContext) {
    req.logContext.userId = claims.userId;
  }

  next();
}
