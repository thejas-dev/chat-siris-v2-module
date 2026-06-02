import type { Request, Response } from "express";
import mongoose from "mongoose";
import {
  ProfileModel,
  toProfileJson,
  type ProfileJson,
} from "../models/profile.model";
import { sendInternalError } from "../middleware/hmac.middleware";
import {
  cacheProfile,
  getCachedProfile,
  invalidateProfileCache,
} from "../services/profile-cache.service";
import { sendLegacyError } from "../middleware/gateway.middleware";

type CreateProfileBody = {
  _id?: string;
  username: string;
  email?: string;
  avatarImage: string;
  isAvatarImageSet: boolean;
};

type UpdateProfileBody = Partial<{
  username: string;
  avatarImage: string;
  isAvatarImageSet: boolean;
  backgroundImage: string;
  admin: string;
  inChannel: string;
}>;

type ChannelPointerBody = {
  inChannel: string;
};

function isValidObjectId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

export async function createProfile(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as CreateProfileBody;

  if (!body.username || body.avatarImage === undefined || body.isAvatarImageSet === undefined) {
    sendInternalError(
      req,
      res,
      400,
      "CHAT4000001",
      "username, avatarImage, and isAvatarImageSet are required",
    );
    return;
  }

  if (body.username.length < 3 || body.username.length > 20) {
    sendInternalError(
      req,
      res,
      400,
      "CHAT4000002",
      "username must be between 3 and 20 characters",
    );
    return;
  }

  if (body._id !== undefined && !isValidObjectId(body._id)) {
    sendInternalError(req, res, 400, "CHAT4000003", "Invalid _id format");
    return;
  }

  try {
    const profileData: Record<string, unknown> = {
      username: body.username,
      avatarImage: body.avatarImage,
      isAvatarImageSet: body.isAvatarImageSet,
    };

    if (body._id) {
      profileData._id = new mongoose.Types.ObjectId(body._id);
    }

    const profile = await ProfileModel.create(profileData);
    const json = toProfileJson(profile);
    await cacheProfile(json);
    res.status(201).json(json);
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoServerError &&
      err.code === 11000
    ) {
      sendInternalError(
        req,
        res,
        409,
        "CHAT4090001",
        "Duplicate username",
      );
      return;
    }
    throw err;
  }
}

function paramId(req: Request): string {
  const raw = req.params.id;
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function getProfileById(
  req: Request,
  res: Response,
): Promise<void> {
  const id = paramId(req);

  if (!isValidObjectId(id)) {
    sendInternalError(req, res, 400, "CHAT4000004", "Invalid user id");
    return;
  }

  const cached = await getCachedProfile(id);
  if (cached) {
    res.json(cached);
    return;
  }

  const profile = await ProfileModel.findById(id);
  if (!profile) {
    sendInternalError(req, res, 404, "CHAT4040001", "Profile not found");
    return;
  }

  const json = toProfileJson(profile);
  await cacheProfile(json);
  res.json(json);
}

export async function updateProfile(
  req: Request,
  res: Response,
): Promise<void> {
  const id = paramId(req);
  const body = req.body as UpdateProfileBody;

  if (!isValidObjectId(id)) {
    sendLegacyError(res, 400, "Invalid user id");
    return;
  }

  if (req.gatewayUserId && req.gatewayUserId !== id) {
    sendLegacyError(res, 403, "Not authorized");
    return;
  }

  if (body.username !== undefined) {
    if (body.username.length < 3 || body.username.length > 20) {
      sendLegacyError(res, 400, "username must be between 3 and 20 characters");
      return;
    }
  }

  const profile = await ProfileModel.findById(id);
  if (!profile) {
    sendLegacyError(res, 404, "Profile not found");
    return;
  }

  if (body.username !== undefined) profile.username = body.username;
  if (body.avatarImage !== undefined) profile.avatarImage = body.avatarImage;
  if (body.isAvatarImageSet !== undefined) {
    profile.isAvatarImageSet = body.isAvatarImageSet;
  }
  if (body.backgroundImage !== undefined) {
    profile.backgroundImage = body.backgroundImage;
  }
  if (body.admin !== undefined) profile.admin = body.admin;
  if (body.inChannel !== undefined) profile.inChannel = body.inChannel;

  try {
    await invalidateProfileCache(id);
    await profile.save();
  } catch (err) {
    if (
      err instanceof mongoose.mongo.MongoServerError &&
      err.code === 11000
    ) {
      sendLegacyError(res, 409, "Duplicate username");
      return;
    }
    throw err;
  }

  const obj: ProfileJson = toProfileJson(profile);
  await cacheProfile(obj);
  res.json({ status: true, obj });
}

export async function updateChannelPointer(
  req: Request,
  res: Response,
): Promise<void> {
  const id = paramId(req);
  const body = req.body as ChannelPointerBody;

  if (!isValidObjectId(id)) {
    sendInternalError(req, res, 400, "CHAT4000004", "Invalid user id");
    return;
  }

  if (body.inChannel === undefined) {
    sendInternalError(req, res, 400, "CHAT4000005", "inChannel is required");
    return;
  }

  const profile = await ProfileModel.findById(id);
  if (!profile) {
    sendInternalError(req, res, 404, "CHAT4040001", "Profile not found");
    return;
  }

  await invalidateProfileCache(id);
  profile.inChannel = body.inChannel;
  await profile.save();

  const obj = toProfileJson(profile);
  await cacheProfile(obj);
  res.json({ status: true, obj });
}
