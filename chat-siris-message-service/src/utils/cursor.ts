export type CompoundCursor = {
  createdAt: string;
  _id: string;
};

export function encodeCursor(cursor: CompoundCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeCursor(token: string): CompoundCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw new Error("Invalid cursor token");
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as CompoundCursor).createdAt !== "string" ||
    typeof (parsed as CompoundCursor)._id !== "string"
  ) {
    throw new Error("Invalid cursor payload");
  }

  return {
    createdAt: (parsed as CompoundCursor).createdAt,
    _id: (parsed as CompoundCursor)._id,
  };
}

export function clampHistoryLimit(limit: unknown): number {
  if (limit === undefined || limit === null) {
    return 50;
  }
  const parsed =
    typeof limit === "number" ? limit : Number.parseInt(String(limit), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 50;
  }
  return Math.min(Math.floor(parsed), 100);
}
