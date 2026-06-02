import type { Server, Socket } from "socket.io";
import { createLogger } from "@chat-siris/logger";
import { handleAddUser } from "../handlers/presence.handler";
import {
  handleAddMember,
  handleAddUserToChannel,
  handleChannelUpdate,
  handleRefetchChannels,
  handleRefetchMessages,
  handleRemoveUserFromChannel,
} from "../handlers/channel.handler";
import { handleAddMsg } from "../handlers/message-relay.handler";
import { clearUserPresence } from "../services/presence.service";

const logger = createLogger(process.env.SERVICE_NAME ?? "realtime-service");

export function registerSocketHandlers(io: Server, socket: Socket): void {
  socket.on("add-user", (userId: string) => {
    void handleAddUser(socket, userId);
  });

  socket.on("addUserToChannel", (channelRef: { name: string }) => {
    logger.info("addUserToChannel received", {
      socketId: socket.id,
      channelName: channelRef?.name,
      userId: socket.data.userId,
      hasUsers: Array.isArray(
        (channelRef as { users?: unknown }).users,
      ),
    });
    void handleAddUserToChannel(io, socket, channelRef);
  });

  socket.on("RemoveUserFromChannel", (channelRef: { name: string }) => {
    void handleRemoveUserFromChannel(io, socket, channelRef);
  });

  socket.on("add-member", (payload: { channelName: string; members: unknown }) => {
    handleAddMember(io, socket, payload);
  });

  socket.on("refetchChannels", () => {
    handleRefetchChannels(socket);
  });

  socket.on("refetchMessages", (payload: { group: string }) => {
    handleRefetchMessages(io, socket, payload);
  });

  socket.on("channelUpdate", (data: { name: string }) => {
    handleChannelUpdate(io, data);
  });

  socket.on("add-msg", (payload: { group: string; data: { data?: { _id?: string } } }) => {
    void handleAddMsg(io, payload);
  });

  socket.on("disconnect", () => {
    const userId = socket.data.userId;
    if (userId) {
      void clearUserPresence(userId);
    }
  });
}
