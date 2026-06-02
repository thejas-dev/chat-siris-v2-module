import { Router, type RequestHandler } from "express";
import {
  deleteMessage,
  getMessageHistory,
  sendMessage,
} from "../controllers/message.controller";
import { gatewayMiddleware } from "../middleware/hmac.middleware";
import { createSendRateLimiter } from "../middleware/rate-limit.middleware";

export const internalRouter = Router();

let sendRateLimiterPromise: Promise<RequestHandler> | null = null;

async function getSendRateLimiter(): Promise<RequestHandler> {
  if (!sendRateLimiterPromise) {
    sendRateLimiterPromise = createSendRateLimiter();
  }
  return sendRateLimiterPromise;
}

const sendRateLimiter: RequestHandler = (req, res, next) => {
  void getSendRateLimiter()
    .then((limiter) => limiter(req, res, next))
    .catch(next);
};

internalRouter.post("/messages", gatewayMiddleware, sendRateLimiter, sendMessage);
internalRouter.post("/messages/history", gatewayMiddleware, getMessageHistory);
internalRouter.post("/messages/delete", gatewayMiddleware, deleteMessage);

export function resetSendRateLimiter(): void {
  sendRateLimiterPromise = null;
}
