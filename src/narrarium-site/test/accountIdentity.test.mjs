import assert from "node:assert/strict";
import test from "node:test";
import { accountIdentity, isAccountIdentityCurrent, shouldResetAccountScope } from "../src/auth/accountIdentity.ts";

test("account identity is provider-scoped and email-normalized", () => {
  /** @type {import("../src/store/authStore.ts").AppUser} */
  const google = { provider: "google", name: "A", email: " User@Example.COM ", picture: "" };
  /** @type {import("../src/store/authStore.ts").AppUser} */
  const microsoft = { ...google, provider: "microsoft" };
  assert.equal(accountIdentity(google), "google:user@example.com");
  assert.equal(accountIdentity(microsoft), "microsoft:user@example.com");
  assert.equal(accountIdentity(null), null);
});

test("account ownership rejects stale provider or email", () => {
  /** @type {import("../src/store/authStore.ts").AppUser} */
  const user = { provider: "google", name: "A", email: "user@example.com", picture: "" };
  assert.equal(isAccountIdentityCurrent("google:user@example.com", user), true);
  assert.equal(isAccountIdentityCurrent("microsoft:user@example.com", user), false);
  assert.equal(isAccountIdentityCurrent("google:other@example.com", user), false);
  assert.equal(isAccountIdentityCurrent("google:user@example.com", null), false);
});

test("account scope resets on first use, logout, or identity change", () => {
  assert.equal(shouldResetAccountScope(null, "google:user@example.com"), true);
  assert.equal(shouldResetAccountScope("google:user@example.com", "google:user@example.com"), false);
  assert.equal(shouldResetAccountScope("google:user@example.com", "microsoft:user@example.com"), true);
  assert.equal(shouldResetAccountScope("google:user@example.com", null), true);
});
