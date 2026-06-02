import type { Request, Response } from "express";
import mongoose from "mongoose";
import {
  GroupModel,
  toChannelJson,
  type ChannelJson,
  type UserSnapshot,
} from "../models/group.model";
import {
  sendInternalError,
  sendLegacyError,
} from "../middleware/hmac.middleware";
import {
  hashPassword,
  passwordWrongResponse,
  verifyChannelPassword,
} from "../services/password.service";
import {
  cacheChannelByName,
  cacheMembers,
  cachePublicChannels,
  getCachedAuthz,
  cacheAuthz,
  getCachedChannelByName,
  getCachedPublicChannels,
  invalidateAuthzEntry,
  invalidateChannelCaches,
} from "../services/channel-cache.service";
import { syncInChannel } from "../services/user-client.service";
import { enqueueChannelSync } from "../services/queue.service";
import { publishMemberChanged } from "../services/pubsub.service";

type CreateChannelBody = {
  name: string;
  admin: string;
  adminId: string;
  description?: string;
  password?: string;
  privacy?: boolean;
  users?: UserSnapshot[];
  adminOnly?: boolean;
};

type MembersBody = {
  user?: UserSnapshot;
  password?: string;
  users?: UserSnapshot[];
};

type SearchBody = {
  name: string;
};

type AdminOnlyBody = {
  adminOnly: boolean;
};

export type AuthorizeResponse = {
  allowed: boolean;
  reason?: string;
};

function paramId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

function validateChannelName(name: string): string | null {
  if (name.length < 3 || name.length > 20) {
    return "Channel name must be between 3 and 20 characters";
  }
  return null;
}

function sameUserId(a: string, b: string): boolean {
  return a.toString() === b.toString();
}

async function persistChannelChange(
  channel: ChannelJson,
  requestId?: string,
  userId?: string,
): Promise<void> {
  await invalidateChannelCaches(channel);
  await cacheChannelByName(channel);
  await cacheMembers(channel._id, channel.users);
  await publishMemberChanged(channel._id, channel.name, requestId, userId);
}

async function updateInChannelPointer(
  userId: string,
  channelName: string,
  requestId?: string,
): Promise<void> {
  const ok = await syncInChannel(userId, channelName, requestId);
  if (!ok) {
    await enqueueChannelSync({
      userId,
      channelName,
      action: channelName ? "join" : "leave",
      requestId,
    });
  }
}

export async function createChannel(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as CreateChannelBody;

  if (!body.name || !body.admin || !body.adminId) {
    sendLegacyError(res, 400, "name, admin, and adminId are required");
    return;
  }

  const nameError = validateChannelName(body.name);
  if (nameError) {
    sendLegacyError(res, 400, nameError);
    return;
  }

  if (req.gatewayUserId !== body.adminId) {
    sendLegacyError(res, 403, "Not authorized");
    return;
  }

  try {
    const password =
      body.password !== undefined && body.password !== ""
        ? await hashPassword(body.password)
        : undefined;

    const group = await GroupModel.create({
      name: body.name,
      admin: body.admin,
      adminId: body.adminId,
      description: body.description,
      password,
      privacy: body.privacy ?? false,
      users: body.users ?? [],
      adminOnly: body.adminOnly ?? false,
    });

    const channel = toChannelJson(group);
    await cacheChannelByName(channel);
    await cachePublicChannels(
      (await GroupModel.find({ privacy: false }).sort({ createdAt: -1 })).map(
        toChannelJson,
      ),
    );
    res.json({ status: true, group: channel });
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoServerError &&
      err.code === 11000
    ) {
      res.status(409).json({ status: false, msg: "Channel name already exists" });
      return;
    }
    throw err;
  }
}

export async function getPublicChannels(
  _req: Request,
  res: Response,
): Promise<void> {
  const cached = await getCachedPublicChannels();
  if (cached) {
    res.json({ status: true, data: cached });
    return;
  }

  const groups = await GroupModel.find({ privacy: false }).sort({
    createdAt: -1,
  });
  const data = groups.map(toChannelJson);
  await cachePublicChannels(data);
  res.json({ status: true, data });
}

export async function searchChannels(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as SearchBody;
  const name = body.name ?? "";

  const data = await GroupModel.find({
    name: { $regex: name, $options: "i" },
    privacy: true,
  }).sort({ updatedAt: 1 });

  res.json({ status: true, data: data.map(toChannelJson) });
}

export async function lookupChannel(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as SearchBody;
  const name = body.name;

  if (!name) {
    sendLegacyError(res, 400, "name is required");
    return;
  }

  const cached = await getCachedChannelByName(name);
  if (cached) {
    res.json({ status: true, data: cached });
    return;
  }

  const group = await GroupModel.findOne({ name });
  if (!group) {
    sendLegacyError(res, 404, "Channel not found");
    return;
  }

  const channel = toChannelJson(group);
  await cacheChannelByName(channel);
  res.json({ status: true, data: channel });
}

function findAddedUsers(
  previous: UserSnapshot[],
  next: UserSnapshot[],
): UserSnapshot[] {
  return next.filter(
    (user) => !previous.some((existing) => sameUserId(existing._id, user._id)),
  );
}

function findRemovedUsers(
  previous: UserSnapshot[],
  next: UserSnapshot[],
): UserSnapshot[] {
  return previous.filter(
    (user) => !next.some((existing) => sameUserId(existing._id, user._id)),
  );
}

export async function addMember(req: Request, res: Response): Promise<void> {
  const channelId = paramId(req);
  const body = req.body as MembersBody;
  const requestId = req.logContext?.requestId;

  if (!isValidObjectId(channelId)) {
    sendLegacyError(res, 400, "Invalid channel id");
    return;
  }

  const group = await GroupModel.findById(channelId);
  if (!group) {
    sendLegacyError(res, 404, "Channel not found");
    return;
  }

  const previousUsers = [...group.users];

  if (body.user) {
    const passwordOk = await verifyChannelPassword(
      group.password,
      body.password,
    );
    if (!passwordOk) {
      res.status(403).json(passwordWrongResponse());
      return;
    }

    const alreadyMember = group.users.some((member) =>
      sameUserId(member._id, body.user!._id),
    );
    if (alreadyMember) {
      res.json({ status: true, obj: toChannelJson(group) });
      return;
    }

    group.users.push(body.user);
  } else if (body.users) {
    if (group.password && body.password !== undefined) {
      const passwordOk = await verifyChannelPassword(
        group.password,
        body.password,
      );
      if (!passwordOk) {
        res.status(403).json(passwordWrongResponse());
        return;
      }
    }

    group.users = body.users;
  } else {
    sendLegacyError(res, 400, "user or users is required");
    return;
  }

  await group.save();
  const channel = toChannelJson(group);

  const addedUsers = findAddedUsers(previousUsers, channel.users);
  const removedUsers = findRemovedUsers(previousUsers, channel.users);
  const affectedUserId = addedUsers[0]?._id ?? removedUsers[0]?._id;

  await persistChannelChange(channel, requestId, affectedUserId);

  for (const user of addedUsers) {
    await updateInChannelPointer(user._id, channel.name, requestId);
  }
  for (const user of removedUsers) {
    await updateInChannelPointer(user._id, "", requestId);
  }

  res.json({ status: true, obj: channel });
}

export async function updateAdminOnly(
  req: Request,
  res: Response,
): Promise<void> {
  const channelId = paramId(req);
  const body = req.body as AdminOnlyBody;
  const requestId = req.logContext?.requestId;

  if (!isValidObjectId(channelId)) {
    sendLegacyError(res, 400, "Invalid channel id");
    return;
  }

  const group = await GroupModel.findById(channelId);
  if (!group) {
    sendLegacyError(res, 404, "Channel not found");
    return;
  }

  if (req.gatewayUserId !== group.adminId) {
    sendLegacyError(res, 403, "Not authorized");
    return;
  }

  group.adminOnly = body.adminOnly;
  await group.save();

  const channel = toChannelJson(group);
  await persistChannelChange(channel, requestId);
  res.json({ status: true, obj: channel });
}

export async function authorizeChannel(
  req: Request,
  res: Response,
): Promise<void> {
  const channelId = paramId(req);
  const userId = typeof req.query.userId === "string" ? req.query.userId : "";
  const action =
    req.query.action === "send" || req.query.action === "delete"
      ? req.query.action
      : null;

  if (!isValidObjectId(channelId) || !userId || !action) {
    sendInternalError(
      req,
      res,
      400,
      "CHAT4000001",
      "channel id, userId, and action=send|delete are required",
    );
    return;
  }

  const cached = await getCachedAuthz(userId, channelId);
  if (cached) {
    res.json(cached);
    return;
  }

  const group = await GroupModel.findById(channelId);
  if (!group) {
    sendInternalError(req, res, 404, "CHAT4040001", "Channel not found");
    return;
  }

  const result = computeAuthorization(group, userId, action);
  await cacheAuthz(userId, channelId, result);
  res.json(result);
}

function computeAuthorization(
  group: {
    adminId: string;
    adminOnly: boolean;
    users: UserSnapshot[];
  },
  userId: string,
  action: "send" | "delete",
): AuthorizeResponse {
  const member = group.users.find((user) => sameUserId(user._id, userId));
  if (!member) {
    return { allowed: false, reason: "NOT_MEMBER" };
  }

  if (action === "send" && group.adminOnly && !sameUserId(group.adminId, userId)) {
    return { allowed: false, reason: "ADMIN_ONLY" };
  }

  if (action === "delete" && !sameUserId(group.adminId, userId)) {
    return { allowed: false, reason: "NOT_CHANNEL_ADMIN" };
  }

  return { allowed: true };
}

export async function invalidateAuthzOnMemberChange(
  channelId: string,
  userId?: string,
): Promise<void> {
  if (userId) {
    await invalidateAuthzEntry(userId, channelId);
  }
}
