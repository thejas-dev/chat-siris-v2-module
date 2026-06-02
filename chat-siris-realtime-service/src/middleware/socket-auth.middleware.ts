import type { Socket } from "socket.io";
import { createLogger } from "@chat-siris/logger";
import {
  isSocketAuthRequired,
  verifyAccessToken,
  type SocketAuthClaims,
} from "../services/jwt.service";

const logger = createLogger(process.env.SERVICE_NAME ?? "realtime-service");

declare module "socket.io" {
  interface SocketData {
    userId?: string;
    email?: string;
    jti?: string;
  }
}

export function extractBearerToken(socket: Socket): string | null {
  const auth = socket.handshake.auth as { token?: unknown };
  if (typeof auth?.token === "string" && auth.token.length > 0) {
    return auth.token;
  }

  const header = socket.handshake.headers.authorization;
  if (typeof header === "string" && header.startsWith("Bearer ")) {
    return header.slice(7);
  }

  return null;
}

export function attachClaims(socket: Socket, claims: SocketAuthClaims): void {
  socket.data.userId = claims.userId;
  socket.data.email = claims.email;
  socket.data.jti = claims.jti;
}

export function socketAuthMiddleware(
  socket: Socket,
  next: (err?: Error) => void,
): void {
  if (!isSocketAuthRequired()) {
    next();
    return;
  }

  const token = extractBearerToken(socket);
  if (!token) {
    logger.warn("socket handshake rejected: missing token", {
      socketId: socket.id,
      origin: socket.handshake.headers.origin,
    });
    next(new Error("Authentication required"));
    return;
  }

  const claims = verifyAccessToken(token);
  if (!claims) {
    logger.warn("socket handshake rejected: invalid token", {
      socketId: socket.id,
      origin: socket.handshake.headers.origin,
    });
    next(new Error("Invalid or expired token"));
    return;
  }

  attachClaims(socket, claims);
  next();
}
