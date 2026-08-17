import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUser } from "@/store/authStore";
import {
  LEGACY_OPEN_PATCH_NOTES_KEY,
  UPDATE_DESTINATION_INTENT_KEY,
  UPDATE_DESTINATION_TAB_STATE_KEY,
  UPDATE_INTENT_MAX_AGE_MS,
  beginUpdateDestinationNavigation,
  clearUpdateDestinationIntent,
  clearUpdateDestinationIntentThrough,
  consumeUpdateDestinationIntent,
  createUpdateDestinationIntent,
  hasValidUpdateIntentAuth,
  markUpdateDestinationAuthRequired,
  migrateLegacyUpdateDestinationIntent,
  patchNotesPhysicalUrl,
  readUpdateDestinationIntent,
  resolveUpdateAwareLoginReturnTo,
  updateDestinationLoginReturnTo,
} from "@/pwaUpdateIntent";
import { handleServiceWorkerControllerChange } from "@/pwa";

const TARGET_VERSION = "0.77.0";
const user: AppUser = {
  provider: "google",
  providerAccountId: "immutable-subject",
  name: "Writer",
  email: "writer@example.test",
  picture: "",
};

function validAuth(now = Date.now()) {
  return { accessToken: "access-token", accessTokenExpiry: now + 60_000, user };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, value); },
  };
}

function locationMock() {
  return { replace: vi.fn(), reload: vi.fn() };
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe("PWA update destination intent", () => {
  it("migrates an N-era session marker on N+1 startup and controllerchange uses it", () => {
    const tab = memoryStorage();
    tab.setItem(LEGACY_OPEN_PATCH_NOTES_KEY, "1");

    const migrated = migrateLegacyUpdateDestinationIntent(TARGET_VERSION, Date.now(), tab);
    expect(migrated?.targetVersion).toBe(TARGET_VERSION);
    expect(tab.getItem(LEGACY_OPEN_PATCH_NOTES_KEY)).toBeNull();
    expect(readUpdateDestinationIntent()?.nonce).toBe(migrated?.nonce);

    const browserLocation = locationMock();
    expect(handleServiceWorkerControllerChange("/", browserLocation, TARGET_VERSION, tab)).toBe("patch-notes");
    expect(browserLocation.replace).toHaveBeenCalledWith("/app/patch-notes/");
  });

  it("removes a legacy marker without overwriting a valid current intent", () => {
    const current = createUpdateDestinationIntent("0.78.0")!;
    const tab = memoryStorage();
    tab.setItem(LEGACY_OPEN_PATCH_NOTES_KEY, "1");

    expect(migrateLegacyUpdateDestinationIntent(TARGET_VERSION, Date.now(), tab)?.nonce).toBe(current.nonce);
    expect(readUpdateDestinationIntent()?.targetVersion).toBe("0.78.0");
    expect(tab.getItem(LEGACY_OPEN_PATCH_NOTES_KEY)).toBeNull();
  });

  it("lets every controlled tab navigate once without globally suppressing another tab", () => {
    const intent = createUpdateDestinationIntent(TARGET_VERSION)!;
    const firstTab = memoryStorage();
    const secondTab = memoryStorage();
    const firstLocation = locationMock();
    const secondLocation = locationMock();

    expect(handleServiceWorkerControllerChange("/", firstLocation, TARGET_VERSION, firstTab)).toBe("patch-notes");
    expect(handleServiceWorkerControllerChange("/", secondLocation, TARGET_VERSION, secondTab)).toBe("patch-notes");
    expect(firstLocation.replace).toHaveBeenCalledOnce();
    expect(secondLocation.replace).toHaveBeenCalledOnce();
    expect(readUpdateDestinationIntent()?.nonce).toBe(intent.nonce);

    expect(handleServiceWorkerControllerChange("/", locationMock(), TARGET_VERSION, firstTab)).toBe("ignored");
    expect(handleServiceWorkerControllerChange("/", locationMock(), TARGET_VERSION, secondTab)).toBe("ignored");
  });

  it("reloads each tab once for an update without notes and avoids per-tab loops", () => {
    const firstTab = memoryStorage();
    const secondTab = memoryStorage();
    const firstLocation = locationMock();
    const secondLocation = locationMock();

    expect(handleServiceWorkerControllerChange("/", firstLocation, TARGET_VERSION, firstTab)).toBe("reload");
    expect(handleServiceWorkerControllerChange("/", secondLocation, TARGET_VERSION, secondTab)).toBe("reload");
    expect(handleServiceWorkerControllerChange("/", locationMock(), TARGET_VERSION, firstTab)).toBe("ignored");
    expect(firstLocation.reload).toHaveBeenCalledOnce();
    expect(secondLocation.reload).toHaveBeenCalledOnce();
  });

  it("keeps the intent through unauthenticated login and returns to patch notes", () => {
    const tab = memoryStorage();
    const intent = createUpdateDestinationIntent(TARGET_VERSION)!;
    expect(beginUpdateDestinationNavigation(tab)?.nonce).toBe(intent.nonce);
    expect(markUpdateDestinationAuthRequired("/app/patch-notes", tab)).toBe("/app/patch-notes");
    expect(updateDestinationLoginReturnTo(tab)).toBe("/app/patch-notes");
    expect(resolveUpdateAwareLoginReturnTo(null, tab)).toBe("/app/patch-notes");
    expect(consumeUpdateDestinationIntent(intent.nonce, "0.77.1", validAuth())).toBe(true);
  });

  it("prefers an explicit protected route after a cancelled update login", () => {
    const tab = memoryStorage();
    createUpdateDestinationIntent(TARGET_VERSION);
    beginUpdateDestinationNavigation(tab);
    markUpdateDestinationAuthRequired("/app/patch-notes", tab);

    expect(resolveUpdateAwareLoginReturnTo("/app/books/book-7", tab)).toBe("/app/books/book-7");
    expect(resolveUpdateAwareLoginReturnTo("/app/patch-notes", tab)).toBe("/app/patch-notes");
    expect(readUpdateDestinationIntent()).not.toBeNull();
  });

  it("consumes only with a nonexpired token and immutable account identity", () => {
    const now = Date.now();
    const intent = createUpdateDestinationIntent(TARGET_VERSION, now)!;
    expect(hasValidUpdateIntentAuth(validAuth(now), now)).toBe(true);
    expect(consumeUpdateDestinationIntent(intent.nonce, TARGET_VERSION, {
      ...validAuth(now), accessTokenExpiry: now,
    }, now)).toBe(false);
    expect(consumeUpdateDestinationIntent(intent.nonce, TARGET_VERSION, {
      ...validAuth(now), user: { ...user, providerAccountId: undefined },
    }, now)).toBe(false);
    expect(readUpdateDestinationIntent()?.nonce).toBe(intent.nonce);
    expect(consumeUpdateDestinationIntent(intent.nonce, TARGET_VERSION, validAuth(now), now)).toBe(true);
  });

  it("does not consume until the installed app reaches the target version", () => {
    const intent = createUpdateDestinationIntent(TARGET_VERSION)!;
    expect(consumeUpdateDestinationIntent(intent.nonce, "0.76.99", validAuth())).toBe(false);
    expect(readUpdateDestinationIntent()?.nonce).toBe(intent.nonce);
  });

  it("replaces an older intent only with a newer target version", () => {
    const first = createUpdateDestinationIntent(TARGET_VERSION)!;
    const newer = createUpdateDestinationIntent("0.78.0")!;
    expect(newer.nonce).not.toBe(first.nonce);
    expect(createUpdateDestinationIntent("0.76.0")?.nonce).toBe(newer.nonce);
    expect(createUpdateDestinationIntent(TARGET_VERSION)?.nonce).toBe(newer.nonce);
    expect(readUpdateDestinationIntent()?.targetVersion).toBe("0.78.0");
  });

  it("does not let an older update-only action clear a newer intent", () => {
    const newer = createUpdateDestinationIntent("0.78.0")!;
    clearUpdateDestinationIntentThrough(TARGET_VERSION, memoryStorage());
    expect(readUpdateDestinationIntent()?.nonce).toBe(newer.nonce);
    clearUpdateDestinationIntentThrough("0.79.0", memoryStorage());
    expect(readUpdateDestinationIntent()).toBeNull();
  });

  it("survives clearing the initiating tab session before controllerchange", () => {
    createUpdateDestinationIntent(TARGET_VERSION);
    const recreatedTab = memoryStorage();
    const browserLocation = locationMock();
    expect(handleServiceWorkerControllerChange("/", browserLocation, TARGET_VERSION, recreatedTab)).toBe("patch-notes");
  });

  it("resolves the physical route beneath a deployment base path", () => {
    expect(patchNotesPhysicalUrl("/Narrarium/")).toBe("/Narrarium/app/patch-notes/");
    expect(patchNotesPhysicalUrl("Narrarium")).toBe("/Narrarium/app/patch-notes/");
  });

  it("clears expired intents and permits a safe current update reload", () => {
    const createdAt = Date.now() - UPDATE_INTENT_MAX_AGE_MS - 1;
    localStorage.setItem(UPDATE_DESTINATION_INTENT_KEY, JSON.stringify({
      version: 1,
      route: "/app/patch-notes",
      targetVersion: TARGET_VERSION,
      createdAt,
      expiresAt: createdAt + UPDATE_INTENT_MAX_AGE_MS,
      nonce: "expired-nonce",
      status: "pending",
    }));
    const browserLocation = locationMock();
    expect(handleServiceWorkerControllerChange("/", browserLocation, TARGET_VERSION, memoryStorage())).toBe("reload");
    expect(localStorage.getItem(UPDATE_DESTINATION_INTENT_KEY)).toBeNull();
  });

  it("rejects a malicious route and does not redirect or retain it", () => {
    const createdAt = Date.now();
    localStorage.setItem(UPDATE_DESTINATION_INTENT_KEY, JSON.stringify({
      version: 1,
      route: "https://evil.example/steal",
      targetVersion: TARGET_VERSION,
      createdAt,
      expiresAt: createdAt + UPDATE_INTENT_MAX_AGE_MS,
      nonce: "malicious-nonce",
      status: "pending",
    }));
    const browserLocation = locationMock();
    expect(handleServiceWorkerControllerChange("/", browserLocation, TARGET_VERSION, memoryStorage())).toBe("reload");
    expect(browserLocation.replace).not.toHaveBeenCalled();
    expect(localStorage.getItem(UPDATE_DESTINATION_INTENT_KEY)).toBeNull();
  });

  it("stores only the bounded non-sensitive global and per-tab schemas", () => {
    const tab = memoryStorage();
    createUpdateDestinationIntent(TARGET_VERSION);
    beginUpdateDestinationNavigation(tab);
    const durable = JSON.parse(localStorage.getItem(UPDATE_DESTINATION_INTENT_KEY)!) as Record<string, unknown>;
    const perTab = JSON.parse(tab.getItem(UPDATE_DESTINATION_TAB_STATE_KEY)!) as Record<string, unknown>;
    expect(Object.keys(durable).sort()).toEqual([
      "createdAt", "expiresAt", "nonce", "route", "status", "targetVersion", "version",
    ]);
    expect(Object.keys(perTab).sort()).toEqual(["nonce", "status", "targetVersion", "version"]);
    expect(JSON.stringify({ durable, perTab })).not.toMatch(/token|user|email|secret/i);
    clearUpdateDestinationIntent(tab);
  });
});
