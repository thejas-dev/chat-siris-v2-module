import type { Server, Socket } from "socket.io";
import { createLogger } from "@chat-siris/logger";
import { extractBearerToken } from "../middleware/socket-auth.middleware";
import { isSocketAuthRequired, verifyAccessToken } from "../services/jwt.service";
import { verifyChannelMembership } from "../services/membership.service";

const logger = createLogger(process.env.SERVICE_NAME ?? "realtime-service");

type ChannelRef = {
  name: string;
  users?: Array<{ _id?: string }>;
  [key: string]: unknown;
};

function sameUserId(a: string, b: string): boolean {
  return a === b || String(a) === String(b);
}

function resolveSocketUserId(socket: Socket): string | undefined {
  if (socket.data.userId) {
    return socket.data.userId;
  }
  const token = extractBearerToken(socket);
  const claims = token ? verifyAccessToken(token) : null;
  if (claims?.userId) {
    socket.data.userId = claims.userId;
    return claims.userId;
  }
  return undefined;
}

/** Client sends fresh channel JSON from group-service after join — trust listed members. */
function isUserListedInChannelRef(
  channelRef: ChannelRef,
  userId: string,
): boolean {
  const users = channelRef.users;
  if (!Array.isArray(users)) {
    return false;
  }
  return users.some((entry) => {
    const id = entry?._id;
    return id != null && sameUserId(String(id), userId);
  });
}

export async function handleAddUserToChannel(
  io: Server,
  socket: Socket,
  channelRef: ChannelRef,
): Promise<void> {
  const channelName = channelRef?.name;
  if (!channelName) {
    return;
  }

  if (!isSocketAuthRequired()) {
    await socket.join(channelName);
    logger.info("socket joined channel room", {
      channelName,
      socketId: socket.id,
      roomSize: io.sockets.adapter.rooms.get(channelName)?.size ?? 0,
      auth: "disabled",
    });
    io.to(channelName).emit("channelUpdate", channelRef);
    return;
  }

  const userId = resolveSocketUserId(socket);
  if (!userId) {
    logger.warn("socket channel join skipped: no user id on socket", {
      channelName,
      socketId: socket.id,
    });
    return;
  }

  const listedInPayload = isUserListedInChannelRef(channelRef, userId);
  const membership = listedInPayload
    ? ("member" as const)
    : await verifyChannelMembership(userId, channelName);

  if (membership !== "member") {
    logger.warn("socket channel join denied", {
      userId,
      channelName,
      membership,
      listedInPayload,
      socketId: socket.id,
      usersInPayload: Array.isArray(channelRef.users)
        ? channelRef.users.length
        : 0,
    });
    return;
  }

  await socket.join(channelName);
  logger.info("socket joined channel room", {
    userId,
    channelName,
    socketId: socket.id,
    roomSize: io.sockets.adapter.rooms.get(channelName)?.size ?? 0,
    viaPayload: listedInPayload,
  });
  io.to(channelName).emit("channelUpdate", channelRef);
}

export async function handleRemoveUserFromChannel(
  io: Server,
  socket: Socket,
  channelRef: ChannelRef,
): Promise<void> {
  const channelName = channelRef?.name;
  if (!channelName) {
    return;
  }

  await socket.leave(channelName);
  io.to(channelName).emit("channelUpdate", channelRef);
}

export function handleAddMember(
  io: Server,
  socket: Socket,
  payload: { channelName: string; members: unknown },
): void {
  const { channelName, members } = payload;
  if (!channelName) {
    return;
  }

  void socket.join(channelName);
  io.to(channelName).emit("userJoined", members);
}

export function handleRefetchChannels(socket: Socket): void {
  socket.broadcast.emit("fetch");
}

export function handleRefetchMessages(
  io: Server,
  _socket: Socket,
  payload: { group: string },
): void {
  const group = payload?.group;
  if (!group) {
    return;
  }
  io.to(group).emit("fetchMessages", group);
}

export function handleChannelUpdate(
  io: Server,
  payload: ChannelRef,
): void {
  const name = payload?.name;
  if (!name) {
    return;
  }
  io.to(name).emit("channelDetailsUpdate", payload);
}
