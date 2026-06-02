import { Router, type RequestHandler } from "express";
import { uploadComplete, uploadInit } from "../controllers/media.controller";
import { gatewayMiddleware } from "../middleware/hmac.middleware";
import { createUploadRateLimiter } from "../middleware/rate-limit.middleware";

export const internalRouter = Router();

let uploadRateLimiterPromise: Promise<RequestHandler> | null = null;

async function getUploadRateLimiter(): Promise<RequestHandler> {
  if (!uploadRateLimiterPromise) {
    uploadRateLimiterPromise = createUploadRateLimiter();
  }
  return uploadRateLimiterPromise;
}

const uploadRateLimiter: RequestHandler = (req, res, next) => {
  void getUploadRateLimiter()
    .then((limiter) => limiter(req, res, next))
    .catch(next);
};

internalRouter.post(
  "/media/upload-init",
  gatewayMiddleware,
  uploadRateLimiter,
  (req, res, next) => {
    void uploadInit(req, res).catch(next);
  },
);

internalRouter.post(
  "/media/upload-complete",
  gatewayMiddleware,
  (req, res, next) => {
    void uploadComplete(req, res).catch(next);
  },
);

export function resetUploadRateLimiter(): void {
  uploadRateLimiterPromise = null;
}
