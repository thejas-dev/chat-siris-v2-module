import jwt from "jsonwebtoken";

export type SocketAuthClaims = {
  userId: string;
  email: string;
  jti: string;
  exp: number;
};

function getPublicKey(): string | null {
  const key = process.env.JWT_PUBLIC_KEY;
  if (!key) {
    return null;
  }
  return key.replace(/\\n/g, "\n");
}

export function verifyAccessToken(token: string): SocketAuthClaims | null {
  const publicKey = getPublicKey();
  if (!publicKey) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, publicKey, {
      algorithms: ["RS256"],
    }) as jwt.JwtPayload;

    if (
      typeof decoded.sub !== "string" ||
      typeof decoded.email !== "string" ||
      typeof decoded.jti !== "string" ||
      typeof decoded.exp !== "number"
    ) {
      return null;
    }

    return {
      userId: decoded.sub,
      email: decoded.email,
      jti: decoded.jti,
      exp: decoded.exp,
    };
  } catch {
    return null;
  }
}

export function isSocketAuthRequired(): boolean {
  const raw = process.env.SOCKET_AUTH_REQUIRED ?? "true";
  return raw.toLowerCase() !== "false";
}
