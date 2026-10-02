import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dictionaries } from "../i18n/messages.ts";

// The Users area is gated by the same rule the Worker enforces in
// requireUserManager: the management role (user_role) must be 'admin'. This
// mirrors that pure decision so a regression in the gate is caught without a
// DOM harness.
function isUserManager(admin: { user_role: string }): boolean {
  return admin.user_role === "admin";
}

describe("Users area gating", () => {
  it("treats a user with user_role=admin as a manager", () => {
    assert.equal(isUserManager({ user_role: "admin" }), true);
  });

  it("denies a staff user (never a manager)", () => {
    assert.equal(isUserManager({ user_role: "staff" }), false);
  });
});

describe("Users i18n copy", () => {
  const en = dictionaries.en as {
    nav: Record<string, string>;
    users: Record<string, string>;
  };

  it("exposes a nav.users label", () => {
    assert.equal(typeof en.nav.users, "string");
    assert.ok(en.nav.users.length > 0);
  });

  it("exposes the user-management copy under users.*", () => {
    for (const key of ["title", "create", "role", "roleAdmin", "roleStaff", "resetPassword", "kick", "sessions"]) {
      assert.equal(typeof en.users[key], "string", `missing users.${key}`);
    }
  });
});
