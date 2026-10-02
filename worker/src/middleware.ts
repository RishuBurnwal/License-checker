import { Context, Next } from "hono";
import { USER_ROLE } from "./constants";
import { requireEnv } from "./config";
import { verifyJwt } from "./crypto";
import { fail } from "./http";
import { D1Adapter } from "./db/adapter";
import { Repository } from "./repository";
import { ApiError, Bindings, Variables } from "./types";

// Routes an admin must still reach while their password is expired, otherwise
// they could never satisfy the requirement.
const PASSWORD_CHANGE_EXEMPT_PATHS = ["/api/admin/password", "/api/admin/me", "/api/admin/logout"];

export async function requireAdmin(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) {
  const header = c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (!token) {
    return c.json(fail("UNAUTHORIZED", "Missing bearer token"), 401);
  }
  const payload = await verifyJwt(requireEnv(c.env, "JWT_SECRET"), token);
  if (!payload) {
    return c.json(fail("UNAUTHORIZED", "Invalid or expired token"), 401);
  }
  const repo = new Repository(new D1Adapter(c.env.DB));
  const admin = await repo.getAdminById(Number(payload.sub));
  if (!admin) {
    return c.json(fail("UNAUTHORIZED", "Admin no longer exists"), 401);
  }
  // Stateless kick-out (UM-3): a token stamped with an older epoch than the DB
  // is rejected. A missing epoch (legacy token) is treated as 0.
  if ((payload.epoch ?? 0) !== admin.session_epoch) {
    return c.json(fail("UNAUTHORIZED", "Session has been revoked"), 401);
  }
  if (admin.must_change_password === 1 && !PASSWORD_CHANGE_EXEMPT_PATHS.includes(new URL(c.req.url).pathname)) {
    return c.json(fail("PASSWORD_CHANGE_REQUIRED", "Password must be changed before continuing"), 403);
  }
  c.set("admin", {
    id: admin.id,
    username: admin.username,
    user_role: admin.user_role,
    must_change_password: admin.must_change_password === 1
  });
  await next();
}

// Gate for the Users area: the management role user_role must be 'admin'.
// staff is denied SERVER-SIDE here, not merely hidden in the UI.
export function requireUserManager(c: Context<{ Bindings: Bindings; Variables: Variables }>): void {
  if (!isUserManager(c.get("admin"))) {
    throw new ApiError(403, "FORBIDDEN", "User management access required");
  }
}

export function isUserManager(admin: { user_role: string }): boolean {
  return admin.user_role === USER_ROLE.ADMIN;
}
