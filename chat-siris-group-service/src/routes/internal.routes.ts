import { Router } from "express";
import {
  addMember,
  authorizeChannel,
  createChannel,
  getPublicChannels,
  lookupChannel,
  searchChannels,
  updateAdminOnly,
} from "../controllers/channel.controller";
import { gatewayMiddleware, hmacMiddleware } from "../middleware/hmac.middleware";

export const internalRouter = Router();

internalRouter.post("/channels", gatewayMiddleware, createChannel);
internalRouter.get("/channels/public", gatewayMiddleware, getPublicChannels);
internalRouter.post("/channels/search", gatewayMiddleware, searchChannels);
internalRouter.post("/channels/lookup", gatewayMiddleware, lookupChannel);
internalRouter.post(
  "/channels/:id/members",
  gatewayMiddleware,
  addMember,
);
internalRouter.post(
  "/channels/:id/admin-only",
  gatewayMiddleware,
  updateAdminOnly,
);
internalRouter.get("/channels/:id/authorize", hmacMiddleware, authorizeChannel);
