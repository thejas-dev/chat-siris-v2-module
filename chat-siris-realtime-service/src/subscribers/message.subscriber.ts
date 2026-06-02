export type MessageCreatedPayload = {
  event: "message.created";
  requestId: string;
  channelName: string;
  message: {
    _id: string;
    group: string;
    message: { text: string };
    byUserName: string;
    byUserImage: string;
    createdAt: string;
    updatedAt: string;
  };
  emittedAt: string;
};

export type MessageDeletedPayload = {
  event: "message.deleted";
  requestId: string;
  channelName: string;
  messageId: string;
};
