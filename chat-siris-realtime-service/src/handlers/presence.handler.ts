import type { Socket } from "socket.io";
import { isSocketAuthRequired } from "../services/jwt.service";
import { setUserPresence } from "../services/presence.service";

export async function handleAddUser(socket: Socket, userId: string): Promise<void> {
  if (isSocketAuthRequired()) {
    const jwtUserId = socket.data.userId;
    if (!jwtUserId || jwtUserId !== userId) {
      return;
    }
  }

  await setUserPresence(userId, socket.id);
}
