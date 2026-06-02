import { Router } from "express";
import {
  createProfile,
  getProfileById,
  updateChannelPointer,
  updateProfile,
} from "../controllers/profile.controller";
import { createSubscribe } from "../controllers/subscribe.controller";
import { hmacMiddleware } from "../middleware/hmac.middleware";
import {
  gatewayMiddleware,
  requireSelf,
} from "../middleware/gateway.middleware";

export const internalRouter = Router();

internalRouter.post("/users", hmacMiddleware, createProfile);
internalRouter.get("/users/:id", hmacMiddleware, getProfileById);
internalRouter.post(
  "/users/:id/channel-pointer",
  hmacMiddleware,
  updateChannelPointer,
);
internalRouter.post(
  "/users/:id/profile",
  gatewayMiddleware,
  requireSelf,
  updateProfile,
);
internalRouter.post("/subscribe", gatewayMiddleware, createSubscribe);
