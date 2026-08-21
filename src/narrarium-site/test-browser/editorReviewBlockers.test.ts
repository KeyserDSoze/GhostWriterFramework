import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveUnsavedChanges } from "@/hooks/resolveUnsavedChanges";
import { triggerCurrentSave, useSaveStore } from "@/store/saveStore";

beforeEach(() => {
  useSaveStore.setState({ current: null });
  vi.restoreAllMocks();
});

describe("editor review dirty transitions", () => {
  it("registers baseline-based saves for both profile editors", () => {
    const ghostwriters = readFileSync(resolve(process.cwd(), "src/pages/GhostwritersPage.tsx"), "utf8");
    const personas = readFileSync(resolve(process.cwd(), "src/pages/ReaderPersonasPage.tsx"), "utf8");
    expect(ghostwriters).toContain("serializeGhostwriter(profile) !== savedProfile");
    expect(ghostwriters).toContain("useRegisterPageSave({ dirty");
    expect(ghostwriters).toContain("await allowProfileChange()");
    expect(personas).toContain("JSON.stringify(draft) !== savedDraft");
    expect(personas).toContain("useRegisterPageSave({ dirty");
    expect(personas).toContain("if (!await allowProfileChange()) return false");
    expect(personas).toContain("select(next, false)");
    expect(personas).toContain('setSavedDraft(persisted ? JSON.stringify(profile) : "")');
  });

  it("guards ghostwriter deletion with a surviving profile from the same repository head", () => {
    const ghostwriters = readFileSync(resolve(process.cwd(), "src/pages/GhostwritersPage.tsx"), "utf8");
    expect(ghostwriters).toContain("remoteHeadSha: profileSnapshot.remoteHeadSha");
    expect(ghostwriters).toContain("if (!survivorGuard)");
    expect(ghostwriters).toContain("[{ snapshot: profileSnapshot, content: null }, survivorGuard, ...guards]");
  });

  it("keeps the ghostwriter editor inside the mobile viewport", () => {
    const ghostwriters = readFileSync(resolve(process.cwd(), "src/pages/GhostwritersPage.tsx"), "utf8");
    expect(ghostwriters).toContain("max-w-full gap-6 overflow-x-hidden lg:grid-cols-[300px_minmax(0,1fr)]");
    expect(ghostwriters).toContain("flex min-w-0 flex-wrap items-center justify-between gap-2");
    expect(ghostwriters).toContain("min-w-0 truncate");
  });

  it("offers explicit opt-in authentication persistence", () => {
    const login = readFileSync(resolve(process.cwd(), "src/components/auth/LoginScreen.tsx"), "utf8");
    const authStore = readFileSync(resolve(process.cwd(), "src/store/authStore.ts"), "utf8");
    expect(login).toContain('id="remember-me"');
    expect(login).toContain("setInteractiveAuth(accessToken, user, expiresIn, rememberMe)");
    expect(authStore).toContain('localStorage.setItem(PERSISTENT_AUTH_STORAGE_KEY');
    expect(authStore).toContain("writePersistentAuth(null)");
  });

  it("keeps a duplicate dirty until its first save succeeds", async () => {
    let baseline = "";
    const duplicate = { id: "reader:copy", name: "Copy" };
    const serialized = JSON.stringify(duplicate);
    expect(serialized !== baseline).toBe(true);

    const save = vi.fn(async () => {
      baseline = serialized;
      return true;
    });
    useSaveStore.setState({ current: { dirty: serialized !== baseline, save } });

    await expect(triggerCurrentSave()).resolves.toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(serialized !== baseline).toBe(false);
  });

  it("keeps a duplicate dirty when its first save fails", async () => {
    const baseline = "";
    const serialized = JSON.stringify({ id: "reader:copy", name: "Copy" });
    const save = vi.fn().mockResolvedValue(false);
    useSaveStore.setState({ current: { dirty: serialized !== baseline, save } });

    await expect(triggerCurrentSave()).resolves.toBe(false);
    expect(serialized !== baseline).toBe(true);
    expect(useSaveStore.getState().current?.dirty).toBe(true);
  });

  it("requires explicit discard before switching away from an unsaved duplicate", async () => {
    const save = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(false);

    await expect(resolveUnsavedChanges({ dirty: true, save, saveMessage: "save", discardMessage: "discard" })).resolves.toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);

    confirm.mockReset().mockReturnValueOnce(false).mockReturnValueOnce(true);
    await expect(resolveUnsavedChanges({ dirty: true, save, saveMessage: "save", discardMessage: "discard" })).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("registers an unsaved duplicate for the global navigation guard", () => {
    const save = vi.fn().mockResolvedValue(true);
    useSaveStore.setState({ current: { dirty: true, save } });
    expect(useSaveStore.getState().current).toMatchObject({ dirty: true });
  });

  it("continues after a successful explicit save", async () => {
    const save = vi.fn().mockResolvedValue(true);
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);

    await expect(resolveUnsavedChanges({ dirty: true, save, saveMessage: "save", discardMessage: "discard" })).resolves.toBe(true);
    expect(save).toHaveBeenCalledOnce();
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });

  it("preserves dirty work when save fails", async () => {
    const save = vi.fn().mockResolvedValue(false);
    vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    useSaveStore.setState({ current: { dirty: true, save } });

    await expect(resolveUnsavedChanges({ dirty: true, save: triggerCurrentSave, saveMessage: "save", discardMessage: "discard" })).resolves.toBe(false);
    expect(useSaveStore.getState().current?.dirty).toBe(true);
    expect(window.confirm).toHaveBeenCalledTimes(1);
  });

  it("requires a second explicit choice to discard and supports cancel", async () => {
    const save = vi.fn();
    vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(false);
    await expect(resolveUnsavedChanges({ dirty: true, save, saveMessage: "save", discardMessage: "discard" })).resolves.toBe(false);

    vi.mocked(window.confirm).mockReset().mockReturnValueOnce(false).mockReturnValueOnce(true);
    await expect(resolveUnsavedChanges({ dirty: true, save, saveMessage: "save", discardMessage: "discard" })).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("does not prompt clean editors", async () => {
    const confirm = vi.spyOn(window, "confirm");
    await expect(resolveUnsavedChanges({ dirty: false, save: vi.fn(), saveMessage: "save", discardMessage: "discard" })).resolves.toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
