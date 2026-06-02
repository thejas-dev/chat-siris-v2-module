import type { Server } from "socket.io";
import { isMessageIdAllowed } from "../services/anti-spoof-cache";

type AddMsgPayload = {
  group: string;
  data: {
    data?: { _id?: string };
    status?: boolean;
  };
};

export async function handleAddMsg(io: Server, payload: AddMsgPayload): Promise<void> {
  const group = payload?.group;
  const messageId = payload?.data?.data?._id;

  if (!group || !messageId) {
    return;
  }

  const allowed = await isMessageIdAllowed(messageId);
  if (!allowed) {
    return;
  }

  io.to(group).emit("msg-recieve", payload.data);
}
