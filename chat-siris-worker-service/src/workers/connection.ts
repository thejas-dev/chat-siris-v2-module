import { buildBullMqConnection } from "@chat-siris/logger";

export function getBullConnectionOptions(): ReturnType<typeof buildBullMqConnection> & {
  maxRetriesPerRequest: null;
} {
  return {
    ...buildBullMqConnection(),
    maxRetriesPerRequest: null,
  };
}
