import assert from "node:assert/strict";
import test from "node:test";
import { accountIdentity, isAccountIdentityCurrent, requireGoogleProviderAccountId, shouldResetAccountScope } from "../src/auth/accountIdentity.ts";

test("account identity is provider-scoped and subject-based", () => {
  /** @type {import("../src/store/authStore.ts").AppUser} */
  const google = { provider: "google", providerAccountId: "google-subject", name: "A", email: " User@Example.COM ", picture: "" };
  /** @type {import("../src/store/authStore.ts").AppUser} */
  const microsoft = { ...google, provider: "microsoft" };
  assert.equal(accountIdentity(google), "google:google-subject");
  assert.equal(accountIdentity(microsoft), null);
  assert.equal(accountIdentity(null), null);
});

test("legacy Microsoft identity is unusable until interactive immutable reauthentication", () => {
  /** @type {import("../src/store/authStore.ts").AppUser} */
  const legacy = { provider: "microsoft", name: "A", email: "User@example.com", picture: "" };
  assert.equal(accountIdentity(legacy), null);
  assert.equal(accountIdentity({ ...legacy, providerAccountId: "home", homeAccountId: "home", localAccountId: "local" }), "microsoft:home");
});

test("account ownership rejects stale provider or email", () => {
  /** @type {import("../src/store/authStore.ts").AppUser} */
  const user = { provider: "google", providerAccountId: "subject", name: "A", email: "user@example.com", picture: "" };
  assert.equal(isAccountIdentityCurrent("google:subject", user), true);
  assert.equal(isAccountIdentityCurrent("microsoft:user@example.com", user), false);
  assert.equal(isAccountIdentityCurrent("google:other@example.com", user), false);
  assert.equal(isAccountIdentityCurrent("google:user@example.com", null), false);
});

test("Google identity survives email changes but isolates recreated accounts", () => {
  /** @type {import("../src/store/authStore.ts").AppUser} */
  const first = { provider: "google", providerAccountId: "sub-a", name: "A", email: "same@example.com", picture: "" };
  assert.equal(accountIdentity({ ...first, email: "renamed@example.com" }), accountIdentity(first));
  assert.notEqual(accountIdentity({ ...first, providerAccountId: "sub-b" }), accountIdentity(first));
  assert.equal(accountIdentity({ ...first, providerAccountId: undefined }), null);
});

test("Google profile requires a nonempty immutable subject", () => {
  assert.equal(requireGoogleProviderAccountId({ sub: " subject " }), "subject");
  assert.throws(() => requireGoogleProviderAccountId({}), /immutable account subject/);
  assert.throws(() => requireGoogleProviderAccountId({ sub: " " }), /immutable account subject/);
});

test("account scope resets on first use, logout, or identity change", () => {
  assert.equal(shouldResetAccountScope(null, "google:user@example.com"), true);
  assert.equal(shouldResetAccountScope("google:user@example.com", "google:user@example.com"), false);
  assert.equal(shouldResetAccountScope("google:user@example.com", "microsoft:user@example.com"), true);
  assert.equal(shouldResetAccountScope("google:user@example.com", null), true);
});
