export const AUTH_PUBLIC_PATHS: string[] = [
  "/api/auth/login",
  "/api/auth/register",
  "/api/auth/oauth/google",
  "/api/auth/token/refresh",
];

export const AUTH_SERVICE_PATHS = new Map<string, string>([
  ["POST /api/auth/login", "/internal/login"],
  ["POST /api/auth/register", "/internal/register"],
  ["POST /api/auth/oauth/google", "/internal/oauth/google"],
  ["POST /api/auth/token/refresh", "/internal/token/refresh"],
]);

export const TRADITY_PATHS = new Set([
  "/api/auth/tradity",
  "/api/auth/tradityusercheck",
  "/api/auth/tradityusercreate",
  "/api/auth/addtradityimage",
  "/api/auth/removetradityimage",
  "/api/auth/gettradityimage",
]);

const ROLLBACK_AUTH_PATHS = new Set([
  "/api/auth/login",
  "/api/auth/register",
]);

export type UpstreamService =
  | "auth"
  | "monolith"
  | "user"
  | "group"
  | "message"
  | "media"
  | "unresolved";

export type UpstreamTarget = {
  url: string;
  service: UpstreamService;
  internalPath?: string;
  transformBody?: (body: unknown, externalPath: string) => unknown;
};

type RouteMapping = {
  method: string;
  pattern: RegExp;
  service: "user" | "group" | "message" | "media";
  internalPath: (match: RegExpMatchArray) => string;
  transformBody?: (body: unknown, externalPath: string) => unknown;
};

const USER_ROUTE_MAPPINGS: RouteMapping[] = [
  {
    method: "POST",
    pattern: /^\/api\/auth\/updateUser\/([^/]+)$/,
    service: "user",
    internalPath: (m) => `/internal/users/${m[1]}/profile`,
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/deleteBackground\/([^/]+)$/,
    service: "user",
    internalPath: (m) => `/internal/users/${m[1]}/profile`,
    transformBody: () => ({ backgroundImage: "" }),
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/updateName\/([^/]+)$/,
    service: "user",
    internalPath: (m) => `/internal/users/${m[1]}/profile`,
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/updateAvatar\/([^/]+)$/,
    service: "user",
    internalPath: (m) => `/internal/users/${m[1]}/profile`,
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/addChannelToUser\/([^/]+)$/,
    service: "user",
    internalPath: (m) => `/internal/users/${m[1]}/profile`,
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/subscribe$/,
    service: "user",
    internalPath: () => "/internal/subscribe",
  },
];

const GROUP_ROUTE_MAPPINGS: RouteMapping[] = [
  {
    method: "POST",
    pattern: /^\/api\/auth\/createChannel$/,
    service: "group",
    internalPath: () => "/internal/channels",
  },
  {
    method: "GET",
    pattern: /^\/api\/auth\/getAllChannels$/,
    service: "group",
    internalPath: () => "/internal/channels/public",
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/addUserToChannel\/([^/]+)$/,
    service: "group",
    internalPath: (m) => `/internal/channels/${m[1]}/members`,
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/fetchUserRoom$/,
    service: "group",
    internalPath: () => "/internal/channels/lookup",
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/findChannelRoute$/,
    service: "group",
    internalPath: () => "/internal/channels/search",
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/channelAdminUpdate\/([^/]+)$/,
    service: "group",
    internalPath: (m) => `/internal/channels/${m[1]}/admin-only`,
  },
];

const MEDIA_ROUTE_MAPPINGS: RouteMapping[] = [
  {
    method: "POST",
    pattern: /^\/api\/auth\/media\/upload-init$/,
    service: "media",
    internalPath: () => "/internal/media/upload-init",
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/media\/upload-complete$/,
    service: "media",
    internalPath: () => "/internal/media/upload-complete",
  },
];

const MESSAGE_ROUTE_MAPPINGS: RouteMapping[] = [
  {
    method: "POST",
    pattern: /^\/api\/auth\/sendMessage$/,
    service: "message",
    internalPath: () => "/internal/messages",
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/getMessages$/,
    service: "message",
    internalPath: () => "/internal/messages/history",
  },
  {
    method: "POST",
    pattern: /^\/api\/auth\/deleteMessage$/,
    service: "message",
    internalPath: () => "/internal/messages/delete",
  },
];

function normalizePath(path: string): string {
  return path.split("?")[0] ?? path;
}

export function isTradityPath(path: string): boolean {
  return TRADITY_PATHS.has(normalizePath(path));
}

export function isJwtExempt(path: string): boolean {
  const normalized = normalizePath(path);
  return AUTH_PUBLIC_PATHS.includes(normalized);
}

export function isAuthServiceEnabled(): boolean {
  return process.env.AUTH_SERVICE_ENABLED !== "false";
}

export function isUserServiceEnabled(): boolean {
  return process.env.USER_SERVICE_ENABLED !== "false";
}

export function isGroupServiceEnabled(): boolean {
  return process.env.GROUP_SERVICE_ENABLED !== "false";
}

export function isMessageServiceEnabled(): boolean {
  return process.env.MESSAGE_SERVICE_ENABLED !== "false";
}

export function isMediaServiceEnabled(): boolean {
  return process.env.MEDIA_SERVICE_ENABLED !== "false";
}

export function getMonolithUrl(): string {
  return process.env.MONOLITH_URL ?? "http://localhost:3333";
}

export function getAuthServiceUrl(): string {
  return process.env.AUTH_SERVICE_URL ?? "http://localhost:3001";
}

export function getUserServiceUrl(): string {
  return process.env.USER_SERVICE_URL ?? "http://localhost:3002";
}

export function getGroupServiceUrl(): string {
  return process.env.GROUP_SERVICE_URL ?? "http://localhost:3003";
}

export function getMessageServiceUrl(): string {
  return process.env.MESSAGE_SERVICE_URL ?? "http://localhost:3004";
}

export function getMediaServiceUrl(): string {
  return process.env.MEDIA_SERVICE_URL ?? "http://localhost:3005";
}

function matchRoute(
  path: string,
  method: string,
  mappings: RouteMapping[],
): { mapping: RouteMapping; match: RegExpMatchArray } | null {
  const normalized = normalizePath(path);
  for (const mapping of mappings) {
    if (mapping.method !== method.toUpperCase()) {
      continue;
    }
    const match = normalized.match(mapping.pattern);
    if (match) {
      return { mapping, match };
    }
  }
  return null;
}

function resolveUserOrGroupUpstream(
  path: string,
  method: string,
): UpstreamTarget | null {
  if (isUserServiceEnabled()) {
    const userMatch = matchRoute(path, method, USER_ROUTE_MAPPINGS);
    if (userMatch) {
      const internalPath = userMatch.mapping.internalPath(userMatch.match);
      return {
        url: `${getUserServiceUrl()}${internalPath}`,
        service: "user",
        internalPath,
        transformBody: userMatch.mapping.transformBody,
      };
    }
  }

  if (isGroupServiceEnabled()) {
    const groupMatch = matchRoute(path, method, GROUP_ROUTE_MAPPINGS);
    if (groupMatch) {
      const internalPath = groupMatch.mapping.internalPath(groupMatch.match);
      return {
        url: `${getGroupServiceUrl()}${internalPath}`,
        service: "group",
        internalPath,
        transformBody: groupMatch.mapping.transformBody,
      };
    }
  }

  if (isMessageServiceEnabled()) {
    const messageMatch = matchRoute(path, method, MESSAGE_ROUTE_MAPPINGS);
    if (messageMatch) {
      const internalPath = messageMatch.mapping.internalPath(messageMatch.match);
      return {
        url: `${getMessageServiceUrl()}${internalPath}`,
        service: "message",
        internalPath,
        transformBody: messageMatch.mapping.transformBody,
      };
    }
  }

  if (isMediaServiceEnabled()) {
    const mediaMatch = matchRoute(path, method, MEDIA_ROUTE_MAPPINGS);
    if (mediaMatch) {
      const internalPath = mediaMatch.mapping.internalPath(mediaMatch.match);
      return {
        url: `${getMediaServiceUrl()}${internalPath}`,
        service: "media",
        internalPath,
        transformBody: mediaMatch.mapping.transformBody,
      };
    }
  }

  return null;
}

function resolveDisabledServiceRollback(
  path: string,
  method: string,
): UpstreamTarget | null {
  const normalized = normalizePath(path);

  if (!isUserServiceEnabled() && isProfileRoute(path, method)) {
    return { url: `${getMonolithUrl()}${normalized}`, service: "monolith" };
  }

  if (!isGroupServiceEnabled() && isChannelRoute(path, method)) {
    return { url: `${getMonolithUrl()}${normalized}`, service: "monolith" };
  }

  if (!isMessageServiceEnabled() && isMessageRoute(path, method)) {
    return { url: `${getMonolithUrl()}${normalized}`, service: "monolith" };
  }

  if (!isMediaServiceEnabled() && isMediaRoute(path, method)) {
    return { url: `${getMonolithUrl()}${normalized}`, service: "monolith" };
  }

  return null;
}

export function resolveUpstream(
  path: string,
  method: string,
): UpstreamTarget {
  const normalized = normalizePath(path);
  const routeKey = `${method.toUpperCase()} ${normalized}`;

  if (
    !isAuthServiceEnabled() &&
    ROLLBACK_AUTH_PATHS.has(normalized) &&
    method.toUpperCase() === "POST"
  ) {
    return {
      url: `${getMonolithUrl()}${normalized}`,
      service: "monolith",
    };
  }

  const internalPath = AUTH_SERVICE_PATHS.get(routeKey);
  if (internalPath) {
    return {
      url: `${getAuthServiceUrl()}${internalPath}`,
      service: "auth",
      internalPath,
    };
  }

  const microserviceTarget = resolveUserOrGroupUpstream(path, method);
  if (microserviceTarget) {
    return microserviceTarget;
  }

  const rollbackTarget = resolveDisabledServiceRollback(path, method);
  if (rollbackTarget) {
    return rollbackTarget;
  }

  return {
    url: "",
    service: "unresolved",
  };
}

export function isProfileRoute(path: string, method: string): boolean {
  return matchRoute(path, method, USER_ROUTE_MAPPINGS) !== null;
}

export function isChannelRoute(path: string, method: string): boolean {
  return matchRoute(path, method, GROUP_ROUTE_MAPPINGS) !== null;
}

export function isMessageRoute(path: string, method: string): boolean {
  return matchRoute(path, method, MESSAGE_ROUTE_MAPPINGS) !== null;
}

export function isMediaRoute(path: string, method: string): boolean {
  return matchRoute(path, method, MEDIA_ROUTE_MAPPINGS) !== null;
}
