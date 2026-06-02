import { Router } from "express";
import {
  login,
  register,
  oauthGoogle,
  tokenRefresh,
  tokenRevoke,
  tokenIntrospect,
} from "../controllers/auth.controller";
import { hmacMiddleware } from "../middleware/hmac.middleware";
import {
  createLoginRateLimiter,
  createRegisterRateLimiter,
  createRefreshRateLimiter,
} from "../middleware/rate-limit.middleware";
import {
  getRefreshPayload,
  REFRESH_COOKIE_NAME,
} from "../services/token.service";
import { asyncHandler, asyncMiddleware } from "../util/async-handler";

function extractRefreshTokenFromReq(req: {
  cookies?: Record<string, string>;
  body?: { refreshToken?: string };
}): string | undefined {
  const fromCookie = req.cookies?.[REFRESH_COOKIE_NAME];
  if (fromCookie) {
    return fromCookie;
  }
  return req.body?.refreshToken;
}

export async function createInternalRouter(): Promise<Router> {
  const router = Router();
  const loginLimiter = await createLoginRateLimiter();
  const registerLimiter = await createRegisterRateLimiter();
  const refreshLimiter = await createRefreshRateLimiter();

  router.post("/login", loginLimiter, asyncHandler(login));
  router.post("/register", registerLimiter, asyncHandler(register));
  router.post("/oauth/google", asyncHandler(oauthGoogle));

  router.post(
    "/token/refresh",
    asyncMiddleware(async (req, _res, next) => {
      const tokenId = extractRefreshTokenFromReq(req);
      console.log("tokenId", tokenId);
      if (tokenId) {
        const payload = await getRefreshPayload(tokenId);
        if (payload) {
          (req as typeof req & { refreshUserId?: string }).refreshUserId =
            payload.userId;
        }
      }
      next();
    }),
    refreshLimiter,
    asyncHandler(tokenRefresh),
  );

  router.post("/token/revoke", asyncHandler(tokenRevoke));
  router.post("/token/introspect", hmacMiddleware, asyncHandler(tokenIntrospect));

  return router;
}
