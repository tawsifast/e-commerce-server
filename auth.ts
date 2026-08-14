import "dotenv/config";
import type { NextFunction, Request, Response } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose-cjs";
import { ObjectId, type WithId } from "mongodb";

const CLIENT_URL = process.env.CLIENT_URL ?? "http://localhost:3000";

// Better Auth signs access-token JWTs with an EdDSA (Ed25519) key and serves
// the public keys at CLIENT_URL/api/auth/jwks. jose caches the keys.
export const JWKS = createRemoteJWKSet(new URL(`${CLIENT_URL}/api/auth/jwks`));

const ah =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };

// Builds the request authenticator used by route handlers. It verifies the
// `Authorization: Bearer <jwt>` header against the remote JWKS (also checking
// issuer + audience), then reloads the user from Mongo by payload.sub so
// role/blocked changes apply immediately.
export function makeApiUser<T extends { _id: ObjectId; blocked?: boolean }>(
  findUser: (id: ObjectId) => Promise<WithId<T> | null>,
) {
  return async function apiUser(req: Request, res: Response): Promise<WithId<T> | null> {
    if (res.locals.__apiUserChecked) return res.locals.__apiUser ?? null;
    res.locals.__apiUserChecked = true;
    res.locals.__apiUser = null;

    const header = req.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) return null;

    try {
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: CLIENT_URL,
        audience: CLIENT_URL,
      });
      if (!payload.sub) return null;

      const user = await findUser(new ObjectId(payload.sub));
      if (!user || user.blocked) return null;

      res.locals.__apiUser = user;
      return user;
    } catch {
      return null;
    }
  };
}

// Builds the role-guard middleware used by protected routes. Any failed or
// missing token results in 401; a valid token with the wrong role is 403.
export function makeRequireRoles<T extends { _id: ObjectId; blocked?: boolean; role?: string }>(
  apiUser: (req: Request, res: Response) => Promise<WithId<T> | null>,
) {
  return function requireRoles(...roles: string[]) {
    return ah(async (req, res, next) => {
      const user = await apiUser(req, res);
      if (!user) return res.status(401).json({ message: "Not authenticated" });
      if (!roles.includes(user.role ?? "buyer")) {
        return res.status(403).json({ message: "Forbidden" });
      }
      next();
    });
  };
}