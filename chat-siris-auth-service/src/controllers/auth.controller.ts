import type { Request, Response } from "express";
import mongoose from "mongoose";
import { OAuth2Client } from "google-auth-library";
import { IdentityModel } from "../models/identity.model";
import {
  createProfile,
  fetchProfile,
  mergeUser,
  UserServiceError,
  type MergedUser,
} from "../services/user-client.service";
import { syncLegacyUser } from "../services/legacy-user-sync.service";
import {
  issueAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  verifyAccessToken,
  REFRESH_COOKIE_NAME,
  refreshCookieOptions,
  getRefreshPayload,
} from "../services/token.service";

const LEGACY_NOT_REGISTERED_MSG = "Account need to be Regitered";
const SERVICE_UNAVAILABLE_MSG = "Service temporarily unavailable";

function setRefreshCookie(res: Response, tokenId: string): void {
  res.cookie(REFRESH_COOKIE_NAME, tokenId, refreshCookieOptions());
}

async function authSuccess(
  res: Response,
  user: MergedUser,
  accessToken: string,
  refreshToken: string,
): Promise<void> {
  setRefreshCookie(res, refreshToken);
  try {
    await syncLegacyUser(user);
  } catch (err: unknown) {
    console.error("legacy user sync failed", err);
  }
  res.json({
    status: true,
    user,
    accessToken,
    refreshToken,
  });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { email } = req.body as { email?: string };

  if (!email || typeof email !== "string") {
    res.status(400).json({ status: false, msg: "email is required" });
    return;
  }

  const identity = await IdentityModel.findOne({
    email: email.toLowerCase().trim(),
  });

  if (!identity) {
    res.json({ status: false, msg: LEGACY_NOT_REGISTERED_MSG });
    return;
  }

  try {
    const profile = await fetchProfile(identity._id.toString());
    const user = mergeUser(
      { _id: identity._id.toString(), email: identity.email },
      profile,
    );
    const { token: accessToken } = issueAccessToken({
      sub: identity._id.toString(),
      email: identity.email,
    });
    const { tokenId: refreshToken } = await issueRefreshToken(
      identity._id.toString(),
    );
    await authSuccess(res, user, accessToken, refreshToken);
  } catch (err) {
    if (err instanceof UserServiceError && err.status >= 500) {
      res.status(503).json({ status: false, msg: SERVICE_UNAVAILABLE_MSG });
      return;
    }
    throw err;
  }
}

export async function register(req: Request, res: Response): Promise<void> {
  const body = req.body as {
    username?: string;
    email?: string;
    avatarImage?: string;
    isAvatarImageSet?: boolean;
  };

  if (
    !body.username ||
    !body.email ||
    body.avatarImage === undefined ||
    body.isAvatarImageSet === undefined
  ) {
    res.status(400).json({
      status: false,
      msg: "username, email, avatarImage, and isAvatarImageSet are required",
    });
    return;
  }

  const email = body.email.toLowerCase().trim();

  const existing = await IdentityModel.findOne({ email });
  if (existing) {
    res.status(409).json({
      status: false,
      msg: "An account with this email already exists",
    });
    return;
  }

  let identityId: mongoose.Types.ObjectId | null = null;

  try {
    const identity = await IdentityModel.create({ email });
    identityId = identity._id;

    const profile = await createProfile({
      _id: identity._id.toString(),
      username: body.username,
      avatarImage: body.avatarImage,
      isAvatarImageSet: body.isAvatarImageSet,
    });

    const user = mergeUser(
      { _id: identity._id.toString(), email: identity.email },
      profile,
    );
    const { token: accessToken } = issueAccessToken({
      sub: identity._id.toString(),
      email: identity.email,
    });
    const { tokenId: refreshToken } = await issueRefreshToken(
      identity._id.toString(),
    );
    await authSuccess(res, user, accessToken, refreshToken);
  } catch (err) {
    if (identityId) {
      await IdentityModel.findByIdAndDelete(identityId);
    }

    if (err instanceof UserServiceError) {
      if (err.status === 409) {
        res.status(409).json({
          status: false,
          msg: "Username is already taken",
        });
        return;
      }
      if (err.status >= 500) {
        res.status(503).json({ status: false, msg: SERVICE_UNAVAILABLE_MSG });
        return;
      }
    }

    if (
      err instanceof mongoose.mongo.MongoServerError &&
      err.code === 11000
    ) {
      res.status(409).json({
        status: false,
        msg: "An account with this email already exists",
      });
      return;
    }

    throw err;
  }
}

let googleClient: OAuth2Client | null = null;

function getGoogleClient(): OAuth2Client {
  if (!googleClient) {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      throw new Error("GOOGLE_CLIENT_ID is required");
    }
    googleClient = new OAuth2Client(clientId);
  }
  return googleClient;
}

export async function oauthGoogle(req: Request, res: Response): Promise<void> {
  const { idToken } = req.body as { idToken?: string };

  if (!idToken || typeof idToken !== "string") {
    res.status(401).json({
      status: false,
      msg: "Authentication required",
    });
    return;
  }

  let payload: { email?: string | null; sub?: string | null };
  try {
    const ticket = await getGoogleClient().verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    payload = ticket.getPayload() ?? {};
  } catch {
    res.status(401).json({
      status: false,
      msg: "Authentication required",
    });
    return;
  }

  if (!payload.email) {
    res.status(401).json({
      status: false,
      msg: "Authentication required",
    });
    return;
  }

  const email = payload.email.toLowerCase().trim();
  const googleSub = payload.sub ?? undefined;

  let identity = await IdentityModel.findOne({ email });

  if (!identity && googleSub) {
    identity = await IdentityModel.findOne({ googleSub });
  }

  if (!identity) {
    identity = await IdentityModel.create({
      email,
      ...(googleSub ? { googleSub } : {}),
    });
  } else if (googleSub && !identity.googleSub) {
    identity.googleSub = googleSub;
    await identity.save();
  }

  try {
    let profile;
    try {
      profile = await fetchProfile(identity._id.toString());
    } catch (err) {
      if (err instanceof UserServiceError && err.status === 404) {
        const username = email.split("@")[0]?.slice(0, 20) ?? "user";
        const safeUsername =
          username.length >= 3 ? username : `${username}usr`.slice(0, 20);
        profile = await createProfile({
          _id: identity._id.toString(),
          username: safeUsername,
          avatarImage: "",
          isAvatarImageSet: false,
        });
      } else {
        throw err;
      }
    }

    const user = mergeUser(
      { _id: identity._id.toString(), email: identity.email },
      profile,
    );
    const { token: accessToken } = issueAccessToken({
      sub: identity._id.toString(),
      email: identity.email,
    });
    const { tokenId: refreshToken } = await issueRefreshToken(
      identity._id.toString(),
    );
    await authSuccess(res, user, accessToken, refreshToken);
  } catch (err) {
    if (err instanceof UserServiceError && err.status >= 500) {
      res.status(503).json({ status: false, msg: SERVICE_UNAVAILABLE_MSG });
      return;
    }
    throw err;
  }
}

function extractRefreshToken(req: Request): string | undefined {
  const fromCookie = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (fromCookie) {
    return fromCookie;
  }
  const body = req.body as { refreshToken?: string };
  return body.refreshToken;
}

export async function tokenRefresh(req: Request, res: Response): Promise<void> {
  const tokenId = extractRefreshToken(req);

  if (!tokenId) {
    res.status(401).json({ status: false, msg: "Authentication required" });
    return;
  }

  const existing = await getRefreshPayload(tokenId);
  if (!existing) {
    res.status(401).json({ status: false, msg: "Authentication required" });
    return;
  }

  (req as Request & { refreshUserId?: string }).refreshUserId =
    existing.userId;

  const result = await rotateRefreshToken(tokenId);
  if (!result) {
    res.status(401).json({ status: false, msg: "Authentication required" });
    return;
  }

  if (result.refreshToken) {
    setRefreshCookie(res, result.refreshToken);
  }

  res.json({
    accessToken: result.accessToken,
    ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
  });
}

export async function tokenRevoke(req: Request, res: Response): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ status: false, msg: "Authentication required" });
    return;
  }

  const token = authHeader.slice(7);
  const claims = verifyAccessToken(token);
  if (!claims) {
    res.status(401).json({ status: false, msg: "Authentication required" });
    return;
  }

  const refreshId = extractRefreshToken(req);
  if (refreshId) {
    await revokeRefreshToken(refreshId);
  }

  res.json({ status: true });
}

export async function tokenIntrospect(
  req: Request,
  res: Response,
): Promise<void> {
  const { token } = req.body as { token?: string };

  if (!token || typeof token !== "string") {
    res.status(401).json({ active: false });
    return;
  }

  const claims = verifyAccessToken(token);
  if (!claims) {
    res.json({ active: false });
    return;
  }

  res.json({
    active: true,
    sub: claims.sub,
    email: claims.email,
    jti: claims.jti,
    exp: claims.exp,
  });
}
