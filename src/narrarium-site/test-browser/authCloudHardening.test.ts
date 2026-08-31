import { describe, expect, it, vi } from "vitest";
import type { AccountInfo } from "@azure/msal-browser";
import { findMicrosoftAccountIn, microsoftMsalInstance, MICROSOFT_REMEMBER_ME_KEY, microsoftSilentRequest, persistentMsalInstance, sessionMsalInstance, setMicrosoftRememberMe } from "@/config/msal";
import { ensureMicrosoftAppMarker, graphPath, verifyMicrosoftAppFolder } from "@/drive/microsoftAppFolder";
import { useCostsStore } from "@/costs/costsStore";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { acquireCloudWriteLease, acquireDurableCloudLeaseForTests, assertCloudWriteAllowed, cloudDeletionReconnectState, completeCloudDeletion, completeCloudDeletionNothingToDelete, completeCloudDeletionTargetForTests, completedCloudDeletionGeneration, crashNextCloudDeletionMutationAfterCompletedMarkForTests, crashNextCloudDeletionMutationAfterProviderSuccessForTests, crashNextCloudDeletionTransitionAfterCommitForTests, crashNextCloudResumeAfterCommitForTests, expireCloudDeletionLeaseForTests, failActiveCloudHeartbeatForTests, failCloudDeletion, failNextCloudResumeTransactionForTests, fencedCloudDeletionMutation, fencedCloudMutation, invalidateActiveCloudFenceForTests, journalCloudDeletionTargets, registerCloudAccount, reserveCloudDeletionForTests, resumeCloudWrites, suspendCloudWrites, writeCloudTombstoneMirrorForTests } from "@/drive/cloudWriteBarrier";
import { deleteVerifiedGoogleAppFolders } from "@/drive/googleAppFolder";
import { deleteNarrariumCloudData } from "@/drive/migration";
import { triggerCurrentSave, useSaveStore } from "@/store/saveStore";
import "fake-indexeddb/auto";

function account(homeAccountId: string, email: string): AccountInfo {
  return { homeAccountId, localAccountId: `local-${homeAccountId}`, environment: "login.microsoftonline.com", tenantId: "tenant", username: email } as AccountInfo;
}

describe("non-Copilot auth and cloud hardening", () => {
  it("uses the SPA entrypoint for Microsoft popup and silent authentication", () => {
    expect(microsoftSilentRequest(account("home-test", "test@example.com")).redirectUri).not.toMatch(/msal-popup\.html$/);
  });

  it("selects the MSAL cache from the Microsoft remember preference", () => {
    localStorage.removeItem(MICROSOFT_REMEMBER_ME_KEY);
    expect(microsoftMsalInstance(false)).toBe(sessionMsalInstance);
    expect(microsoftMsalInstance(true)).toBe(persistentMsalInstance);
    setMicrosoftRememberMe(true);
    expect(microsoftMsalInstance()).toBe(persistentMsalInstance);
    setMicrosoftRememberMe(false);
    expect(microsoftMsalInstance()).toBe(sessionMsalInstance);
  });

  it("never substitutes the active/sole Microsoft account for an expected immutable account", () => {
    const other = account("home-b", "b@example.com");
    expect(findMicrosoftAccountIn({ homeAccountId: "home-a", localAccountId: "local-home-a", email: "a@example.com" }, [other])).toBeNull();
    expect(findMicrosoftAccountIn({ email: "a@example.com" }, [other])).toBeNull();
    expect(findMicrosoftAccountIn({ email: " B@EXAMPLE.COM " }, [other])).toBeNull();
  });

  it("encodes each Graph path segment without changing hierarchy", () => {
    expect(graphPath("Folder #1/why?/100%/slash name")).toBe("Folder%20%231/why%3F/100%25/slash%20name");
  });

  it("refuses unrelated or unmarked OneDrive folders", async () => {
    registerCloudAccount("microsoft", "token", "home-a");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-a" });
      if (url.includes("/root:/Apps/Narrarium")) return Response.json({ id: "folder", folder: {}, createdBy: { user: { id: "graph-a" } } });
      if (url.includes("/items/folder/children")) return Response.json({ value: [{ id: "personal", name: "personal.docx", eTag: "p1", file: {} }] });
      throw new Error(`Unexpected request ${url}`);
    }));
    await expect(verifyMicrosoftAppFolder("token")).rejects.toThrow(/unrelated data/);
    vi.unstubAllGlobals();
  });

  it("does not accept the old deterministic OneDrive marker as ownership proof", async () => {
    registerCloudAccount("microsoft", "legacy-token", "home-legacy");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-legacy" });
      if (url.includes("/root:/Apps/Narrarium")) return Response.json({ id: "folder", folder: {}, createdBy: { user: { id: "graph-legacy" } } });
      if (url.includes("/items/folder/children")) return Response.json({ value: [{ id: "marker", name: ".narrarium-app-folder-v1.json", eTag: "m1", file: {} }, { id: "settings", name: "settings.json", eTag: "s1", file: {} }] });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content")) return Response.json({ application: "Narrarium", purpose: "app-cloud-data", version: 1 });
      throw new Error(`Unexpected request ${url}`);
    }));
    await expect(verifyMicrosoftAppFolder("legacy-token")).rejects.toThrow(/not owned/);
    vi.unstubAllGlobals();
  });

  it("accepts the same immutable Microsoft account on a fresh device with ordinary app children", async () => {
    registerCloudAccount("microsoft", "fresh-device-token", "home-fresh");
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-fresh" });
      if (url.includes("/root:/Apps/Narrarium?") && url.includes("createdBy")) return Response.json({ id: "folder-fresh", folder: {}, createdBy: { user: { id: "graph-fresh" } } });
      if (url.includes("/items/folder-fresh/children")) return Response.json({ value: [
        { id: "marker-fresh", name: ".narrarium-app-folder-v1.json", eTag: "m1", file: {} },
        { id: "settings-fresh", name: "settings.json", eTag: "s1", file: {} },
        { id: "costs-fresh", name: "costs.json", eTag: "c1", file: {} },
        { id: "chats-fresh", name: "chats", eTag: "h1", folder: {} },
      ] });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content")) return Response.json({ application: "Narrarium", version: 3, provider: "microsoft", providerAccountId: "home-fresh", graphUserId: "graph-fresh" });
      throw new Error(`Unexpected request ${url}`);
    }));
    await expect(verifyMicrosoftAppFolder("fresh-device-token")).resolves.toMatchObject({ id: "folder-fresh", children: expect.arrayContaining([expect.objectContaining({ name: "costs.json" }), expect.objectContaining({ name: "chats" })]) });
    vi.unstubAllGlobals();
  });

  it("migrates a legacy secret marker only after same-account folder proof and preserves ordinary children", async () => {
    registerCloudAccount("microsoft", "legacy-fresh-token", "home-legacy-fresh");
    let migratedBody = "";
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-legacy-fresh" });
      if (url.includes("/root:/Apps/Narrarium?") && url.includes("createdBy")) return Response.json({ id: "folder-legacy-fresh", folder: {}, createdBy: { user: { id: "graph-legacy-fresh" } } });
      if (url.includes("/items/folder-legacy-fresh/children")) return Response.json({ value: [
        { id: "marker", name: ".narrarium-app-folder-v1.json", eTag: "m1", file: {} },
        { id: "costs", name: "costs.json", eTag: "c1", file: {} },
        { id: "exports", name: "Exports", eTag: "e1", folder: {} },
      ] });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content") && init?.method !== "PUT") return new Response(JSON.stringify({ application: "Narrarium", version: 2, secret: "old-device-secret" }), { headers: { etag: "m1" } });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content") && init?.method === "PUT") {
        migratedBody = String(init.body);
        return Response.json({ id: "marker" });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    await expect(withMicrosoftLease("legacy-fresh-token", () => ensureMicrosoftAppMarker("legacy-fresh-token"))).resolves.toBeUndefined();
    expect(JSON.parse(migratedBody)).toEqual({ application: "Narrarium", version: 3, provider: "microsoft", providerAccountId: "home-legacy-fresh", graphUserId: "graph-legacy-fresh" });
    expect(vi.mocked(fetch).mock.calls.some(([input, init]) => String(input).includes("/items/costs") && init?.method === "DELETE")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("rejects a foreign account marker even when the folder creator matches", async () => {
    registerCloudAccount("microsoft", "foreign-marker-token", "home-current");
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-current" });
      if (url.includes("/root:/Apps/Narrarium?") && url.includes("createdBy")) return Response.json({ id: "folder-current", folder: {}, createdBy: { user: { id: "graph-current" } } });
      if (url.includes("/items/folder-current/children")) return Response.json({ value: [{ id: "marker", name: ".narrarium-app-folder-v1.json", eTag: "m1", file: {} }] });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content")) return Response.json({ application: "Narrarium", version: 3, provider: "microsoft", providerAccountId: "home-foreign", graphUserId: "graph-foreign" });
      throw new Error(`Unexpected request ${url}`);
    }));
    await expect(verifyMicrosoftAppFolder("foreign-marker-token")).rejects.toThrow(/not owned/);
    await expect(ensureMicrosoftAppMarker("foreign-marker-token")).rejects.toThrow(/another account/);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    vi.unstubAllGlobals();
  });

  it("rejects an unrelated OneDrive child found on a later page", async () => {
    registerCloudAccount("microsoft", "paged-token", "home-paged");
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-paged" });
      if (url.includes("/root:/Apps/Narrarium")) return Response.json({ id: "folder", folder: {}, createdBy: { user: { id: "graph-paged" } } });
      if (url.includes("/items/folder/children") && !url.includes("page=2")) return Response.json({ value: [{ id: "marker", name: ".narrarium-app-folder-v1.json", eTag: "m1", file: {} }], "@odata.nextLink": "https://graph.microsoft.com/page=2" });
      if (url.includes("page=2")) return Response.json({ value: [{ id: "personal", name: "personal.docx", eTag: "p1", file: {} }] });
      throw new Error(`Unexpected request ${url}`);
    }));
    await expect(verifyMicrosoftAppFolder("paged-token")).rejects.toThrow(/unrelated data/);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("$select=id,name,eTag,file,folder"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("treats undefined registered save results as failures", async () => {
    useSaveStore.setState({ current: { dirty: true, save: (() => undefined) as unknown as () => boolean } });
    expect(await triggerCurrentSave()).toBe(false);
    useSaveStore.setState({ current: null });
  });

  it("does not run a clean page save before activating an app update", async () => {
    const save = vi.fn(() => true);
    useSaveStore.setState({ current: { dirty: false, save } });
    await expect(triggerCurrentSave()).resolves.toBe(true);
    expect(save).not.toHaveBeenCalled();
    useSaveStore.setState({ current: null });
  });

  it("serializes deterministic independent durable lease owners without Web Locks", async () => {
    const id = `two-context-${crypto.randomUUID()}`;
    const first = await acquireDurableCloudLeaseForTests(id);
    let secondAcquired = false;
    const secondPromise = acquireDurableCloudLeaseForTests(id).then((release) => { secondAcquired = true; return release; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondAcquired).toBe(false);
    await first();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    await second();
  });


  it("rejects stale reconnect generations and stale writer fences", async () => {
    const token = `fence-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, "fence@example.com");
    const deletion = await suspendCloudWrites("google", token);
    await completeCloudDeletionTargetForTests(deletion);
    await completeCloudDeletion(deletion, true);
    const generation = (await completedCloudDeletionGeneration("google", token))!;
    await expect(resumeCloudWrites("google", token, "stale-generation")).resolves.toBe(false);
    await expect(resumeCloudWrites("google", token, generation)).resolves.toBe(true);
    const release = await acquireCloudWriteLease("google", token);
    await invalidateActiveCloudFenceForTests("google", token);
    await expect(assertCloudWriteAllowed("google", token)).rejects.toThrow(/stale/);
    await release();
  });

  it("aborts an in-flight provider fetch when heartbeat ownership is lost", async () => {
    const token = `heartbeat-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, "heartbeat@example.com");
    const release = await acquireCloudWriteLease("google", token);
    let fetchStarted!: () => void;
    const started = new Promise<void>((resolve) => { fetchStarted = resolve; });
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      fetchStarted();
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));
    const pending = fencedCloudMutation("google", token, "https://example.test/write", { method: "POST" });
    await started;
    failActiveCloudHeartbeatForTests("google", token);
    await expect(pending).rejects.toThrow(/heartbeat failed/);
    await release();
    vi.unstubAllGlobals();
  });

  it("does not let a concurrent deleter overwrite the active owner generation", async () => {
    const token = `delete-owner-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, "delete-owner@example.com");
    const first = await suspendCloudWrites("google", token);
    await expect(suspendCloudWrites("google", token)).rejects.toThrow(/Another cloud deletion/);
    await completeCloudDeletionTargetForTests(first);
    await completeCloudDeletion(first, true);
    expect(await completedCloudDeletionGeneration("google", token)).toBe(first.generation);
    await expect(resumeCloudWrites("google", token, first.generation)).resolves.toBe(true);
  });

  it("keeps local suspension on durable resume failure and succeeds on retry", async () => {
    const token = `resume-failure-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, `resume-failure-${crypto.randomUUID()}`);
    const deletion = await suspendCloudWrites("google", token);
    await completeCloudDeletionTargetForTests(deletion);
    await completeCloudDeletion(deletion, true);
    failNextCloudResumeTransactionForTests();
    await expect(resumeCloudWrites("google", token, deletion.generation)).rejects.toThrow(/aborted/);
    await expect(acquireCloudWriteLease("google", token)).rejects.toThrow(/suspended/);
    await expect(resumeCloudWrites("google", token, deletion.generation)).resolves.toBe(true);
    const release = await acquireCloudWriteLease("google", token);
    await release();
  });

  it("retries idempotently after a crash following durable resume", async () => {
    const token = `resume-crash-${crypto.randomUUID()}`;
    const identity = `resume-crash-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, identity);
    const deletion = await suspendCloudWrites("google", token);
    await completeCloudDeletionTargetForTests(deletion);
    await completeCloudDeletion(deletion, true);
    crashNextCloudResumeAfterCommitForTests();
    await expect(resumeCloudWrites("google", token, deletion.generation)).rejects.toThrow(/Simulated crash/);

    const observer = new BroadcastChannel("narrarium-cloud-write-barrier-v3");
    const observed = new Promise<unknown>((resolve) => observer.addEventListener("message", (event) => resolve(event.data), { once: true }));
    await expect(completedCloudDeletionGeneration("google", token)).resolves.toBeNull();
    await expect(observed).resolves.toMatchObject({ id: `google:${identity}`, tombstone: null });
    await expect(resumeCloudWrites("google", token, deletion.generation)).resolves.toBe(true);
    const release = await acquireCloudWriteLease("google", token);
    await release();
    observer.close();
  });

  it("recovers a durable deleted generation after crashing before its mirror", async () => {
    const token = `complete-crash-${crypto.randomUUID()}`;
    const identity = `complete-crash-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, identity);
    const deletion = await suspendCloudWrites("google", token);
    await completeCloudDeletionTargetForTests(deletion);
    crashNextCloudDeletionTransitionAfterCommitForTests();
    await expect(completeCloudDeletion(deletion, true)).rejects.toThrow(/Simulated crash/);

    const observer = new BroadcastChannel("narrarium-cloud-write-barrier-v3");
    const observed = new Promise<unknown>((resolve) => observer.addEventListener("message", (event) => resolve(event.data), { once: true }));
    await expect(completedCloudDeletionGeneration("google", token)).resolves.toBe(deletion.generation);
    await expect(observed).resolves.toMatchObject({ id: `google:${identity}`, tombstone: { generation: deletion.generation, state: "deleted" } });
    await expect(resumeCloudWrites("google", token, deletion.generation)).resolves.toBe(true);
    observer.close();
  });

  it("does not let an observed stale generation clear a newer durable tombstone", async () => {
    const token = `resume-stale-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, `resume-stale-${crypto.randomUUID()}`);
    const first = await suspendCloudWrites("google", token);
    await completeCloudDeletionTargetForTests(first);
    await completeCloudDeletion(first, true);
    await resumeCloudWrites("google", token, first.generation);
    const newer = await suspendCloudWrites("google", token);
    await completeCloudDeletionTargetForTests(newer);
    await completeCloudDeletion(newer, true);
    await expect(resumeCloudWrites("google", token, first.generation)).resolves.toBe(false);
    await expect(acquireCloudWriteLease("google", token)).rejects.toThrow(/suspended/);
    await expect(resumeCloudWrites("google", token, newer.generation)).resolves.toBe(true);
  });

  it("replaces a stale local deleted mirror with the newer durable deleting generation", async () => {
    const token = `mirror-stale-${crypto.randomUUID()}`;
    const identity = `mirror-stale-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, identity);
    const stale = await suspendCloudWrites("google", token);
    await completeCloudDeletionTargetForTests(stale);
    await completeCloudDeletion(stale, true);
    await resumeCloudWrites("google", token, stale.generation);
    const newer = await suspendCloudWrites("google", token);
    writeCloudTombstoneMirrorForTests(stale, "deleted");

    const observer = new BroadcastChannel("narrarium-cloud-write-barrier-v3");
    const observed = new Promise<unknown>((resolve) => observer.addEventListener("message", (event) => {
      const data = event.data as { tombstone?: { generation?: string; state?: string } };
      if (data.tombstone?.generation === newer.generation) resolve(data);
    }));
    await expect(completedCloudDeletionGeneration("google", token)).resolves.toBeNull();
    await expect(observed).resolves.toMatchObject({ id: `google:${identity}`, tombstone: { generation: newer.generation, state: "deleting" } });
    await expect(resumeCloudWrites("google", token, stale.generation)).resolves.toBe(false);
    await expect(acquireCloudWriteLease("google", token)).rejects.toThrow(/suspended/);
    await expect(completeCloudDeletion(newer, false)).rejects.toThrow(/durable target intent/);
    await expect(acquireCloudWriteLease("google", token)).rejects.toThrow(/suspended/);
    await failCloudDeletion(newer, new Error("No provider target found."));
    observer.close();
  });

  it("publishes resume only after durable completion for another tab", async () => {
    const token = `resume-tab-${crypto.randomUUID()}`;
    const identity = `resume-tab-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, identity);
    const deletion = await suspendCloudWrites("google", token);
    await completeCloudDeletionTargetForTests(deletion);
    await completeCloudDeletion(deletion, true);
    const observer = new BroadcastChannel("narrarium-cloud-write-barrier-v3");
    const observed = new Promise<unknown>((resolve) => observer.addEventListener("message", (event) => resolve(event.data), { once: true }));
    await resumeCloudWrites("google", token, deletion.generation);
    await expect(observed).resolves.toMatchObject({ id: `google:${identity}`, tombstone: null });
    observer.close();
  });

  it("blocks a writer from deletion reservation before tombstone publication", async () => {
    const token = `reserved-delete-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, "reserved-delete@example.com");
    const clearReservation = await reserveCloudDeletionForTests("google", token);
    await expect(acquireCloudWriteLease("google", token)).rejects.toThrow(/suspended/);
    await clearReservation();
  });

  it("recovers Google deletion only from an exact durable target intent after provider success", async () => {
    const token = `google-target-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, `google-target-${crypto.randomUUID()}`);
    const deletion = await suspendCloudWrites("google", token);
    let deletes = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/drive/v3/files/root?")) return Response.json({ id: "root-id" });
      if (url.includes("/drive/v3/files?") && init?.method !== "DELETE") return Response.json({ files: deletes ? [] : [{ id: "folder-1", name: "Narrarium", mimeType: "application/vnd.google-apps.folder", parents: ["root-id"], ownedByMe: true, trashed: false, appProperties: { narrariumAppFolder: "v1" } }] });
      if (url.endsWith("/drive/v3/files/folder-1") && init?.method === "DELETE") return new Response(null, { status: deletes++ ? 404 : 204 });
      if (url.includes("/drive/v3/about?")) return Response.json({ user: { permissionId: "permission-1" } });
      throw new Error(`Unexpected request ${url}`);
    }));
    crashNextCloudDeletionMutationAfterProviderSuccessForTests();
    await expect(deleteVerifiedGoogleAppFolders(token, deletion)).rejects.toThrow(/Simulated crash/);
    await expireCloudDeletionLeaseForTests(deletion);
    const reclaimed = await suspendCloudWrites("google", token);
    expect(reclaimed.operationId).toBe(deletion.operationId);
    expect(reclaimed.generation).not.toBe(deletion.generation);
    expect(reclaimed.owner).not.toBe(deletion.owner);
    expect(reclaimed.fence).toBeGreaterThan(deletion.fence);
    await expect(fencedCloudDeletionMutation(deletion, "https://www.googleapis.com/drive/v3/files/folder-1", { method: "DELETE" })).rejects.toThrow(/ownership/);
    await expect(deleteVerifiedGoogleAppFolders(token, reclaimed)).resolves.toEqual(["folder-1"]);
    await expect(completeCloudDeletion(reclaimed, true)).resolves.toBeUndefined();
    await expect(completedCloudDeletionGeneration("google", token)).resolves.toBe(deletion.operationId);
    await expect(resumeCloudWrites("google", token, deletion.operationId)).resolves.toBe(true);
    expect(deletes).toBe(2);
    vi.unstubAllGlobals();
  });

  it("recovers Microsoft deletion only from an exact durable target intent after provider success", async () => {
    const token = `microsoft-target-${crypto.randomUUID()}`;
    const identity = `microsoft-target-${crypto.randomUUID()}`;
    registerCloudAccount("microsoft", token, identity);
    const deletion = await suspendCloudWrites("microsoft", token);
    const deletes: string[] = [];
    let discoveryCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-target" });
      if (url.includes("/root:/Apps/Narrarium?") && url.includes("createdBy")) { discoveryCalls += 1; return Response.json({ id: "root-1", eTag: "root-tag", folder: {}, createdBy: { user: { id: "graph-target" } } }); }
      if (url.includes("/items/root-1/children")) return Response.json({ value: [{ id: "marker-1", name: ".narrarium-app-folder-v1.json", eTag: "marker-tag", file: {} }, { id: "settings-1", name: "settings.json", eTag: "settings-tag", file: {} }, { id: "costs-1", name: "costs.json", eTag: "costs-tag", file: {} }] });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content")) return Response.json({ application: "Narrarium", version: 3, provider: "microsoft", providerAccountId: identity, graphUserId: "graph-target" });
      if (init?.method === "DELETE") {
        deletes.push(url);
        if (url.endsWith("/items/settings-1")) return new Response(null, { status: deletes.filter((value) => value.endsWith("/items/settings-1")).length > 1 ? 404 : 204 });
        if (url.endsWith("/items/costs-1")) return new Response(null, { status: 204 });
        if (url.endsWith("/items/marker-1")) return new Response(null, { status: 404 });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    crashNextCloudDeletionMutationAfterProviderSuccessForTests();
    await expect(deleteNarrariumCloudData("microsoft", token, deletion)).rejects.toThrow(/Simulated crash/);
    await expireCloudDeletionLeaseForTests(deletion);
    const reclaimed = await suspendCloudWrites("microsoft", token);
    expect(reclaimed.operationId).toBe(deletion.operationId);
    expect(reclaimed.generation).not.toBe(deletion.generation);
    expect(reclaimed.owner).not.toBe(deletion.owner);
    expect(reclaimed.fence).toBeGreaterThan(deletion.fence);
    await expect(fencedCloudDeletionMutation(deletion, "https://graph.microsoft.com/v1.0/me/drive/items/settings-1", { method: "DELETE" })).rejects.toThrow(/ownership/);
    await expect(deleteNarrariumCloudData("microsoft", token, reclaimed)).resolves.toMatchObject({ deleted: true, folderIds: ["settings-1", "costs-1", "marker-1"] });
    await expect(completeCloudDeletion(reclaimed, true)).resolves.toBeUndefined();
    await expect(completedCloudDeletionGeneration("microsoft", token)).resolves.toBe(deletion.operationId);
    await expect(resumeCloudWrites("microsoft", token, deletion.operationId)).resolves.toBe(true);
    expect(deletes.map((url) => url.split("/").pop())).toEqual(["settings-1", "settings-1", "costs-1", "marker-1"]);
    expect(discoveryCalls).toBe(1);
    vi.unstubAllGlobals();
  });

  it("keeps the Microsoft ownership marker strictly last and recovers a crash after its success", async () => {
    const token = `microsoft-marker-${crypto.randomUUID()}`;
    const identity = `microsoft-marker-${crypto.randomUUID()}`;
    registerCloudAccount("microsoft", token, identity);
    const deletion = await suspendCloudWrites("microsoft", token);
    const deletes: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-marker" });
      if (url.includes("/root:/Apps/Narrarium?") && url.includes("createdBy")) return Response.json({ id: "root-marker", eTag: "root-tag", folder: {}, createdBy: { user: { id: "graph-marker" } } });
      if (url.includes("/items/root-marker/children")) return Response.json({ value: [{ id: "marker-last", name: ".narrarium-app-folder-v1.json", eTag: "marker-tag", file: {} }, { id: "settings-first", name: "settings.json", eTag: "settings-tag", file: {} }] });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content")) return Response.json({ application: "Narrarium", version: 3, provider: "microsoft", providerAccountId: identity, graphUserId: "graph-marker" });
      if (init?.method === "DELETE") {
        deletes.push(url);
        if (url.endsWith("/items/marker-last") && deletes.filter((value) => value.endsWith("/items/marker-last")).length === 1) crashNextCloudDeletionMutationAfterProviderSuccessForTests();
        return new Response(null, { status: deletes.filter((value) => value === url).length > 1 ? 404 : 204 });
      }
      throw new Error(`Unexpected request ${url}`);
    }));
    await expect(deleteNarrariumCloudData("microsoft", token, deletion)).rejects.toThrow(/Simulated crash/);
    expect(deletes.map((url) => url.split("/").pop())).toEqual(["settings-first", "marker-last"]);
    await expireCloudDeletionLeaseForTests(deletion);
    const reclaimed = await suspendCloudWrites("microsoft", token);
    await expect(deleteNarrariumCloudData("microsoft", token, reclaimed)).resolves.toMatchObject({ deleted: true });
    expect(deletes.map((url) => url.split("/").pop())).toEqual(["settings-first", "marker-last", "marker-last"]);
    await completeCloudDeletion(reclaimed, true);
    await expect(resumeCloudWrites("microsoft", token, deletion.operationId)).resolves.toBe(true);
    vi.unstubAllGlobals();
  });

  it("does not delete an unjournaled Microsoft child that appears after ownership verification", async () => {
    const token = `microsoft-unjournaled-${crypto.randomUUID()}`;
    const identity = `microsoft-unjournaled-${crypto.randomUUID()}`;
    registerCloudAccount("microsoft", token, identity);
    const deletion = await suspendCloudWrites("microsoft", token);
    const deletes: string[] = [];
    let childListings = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-safe" });
      if (url.includes("/root:/Apps/Narrarium?") && url.includes("createdBy")) return Response.json({ id: "root-safe", folder: {}, createdBy: { user: { id: "graph-safe" } } });
      if (url.includes("/items/root-safe/children")) {
        childListings += 1;
        return Response.json({ value: [{ id: "marker-safe", name: ".narrarium-app-folder-v1.json", eTag: "marker-tag", file: {} }, { id: "settings-safe", name: "settings.json", eTag: "settings-tag", file: {} }] });
      }
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content")) return Response.json({ application: "Narrarium", version: 3, provider: "microsoft", providerAccountId: identity, graphUserId: "graph-safe" });
      if (init?.method === "DELETE") { deletes.push(url); return new Response(null, { status: 204 }); }
      throw new Error(`Unexpected request ${url}`);
    }));
    await deleteNarrariumCloudData("microsoft", token, deletion);
    expect(childListings).toBe(1);
    expect(deletes.some((url) => url.includes("unjournaled"))).toBe(false);
    expect(deletes.map((url) => url.split("/").pop())).toEqual(["settings-safe", "marker-safe"]);
    await completeCloudDeletion(deletion, true);
    vi.unstubAllGlobals();
  });

  it("terminalizes a verified Google no-folder result and resumes writes explicitly", async () => {
    const token = `google-empty-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, `google-empty-${crypto.randomUUID()}`);
    const deletion = await suspendCloudWrites("google", token);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/drive/v3/files/root?")) return Response.json({ id: "root-id" });
      if (String(input).includes("/drive/v3/files?")) return Response.json({ files: [] });
      throw new Error(`Unexpected request ${String(input)}`);
    }));
    await expect(deleteNarrariumCloudData("google", token, deletion)).resolves.toEqual({ deleted: false, count: 0, folderIds: [] });
    await expect(completeCloudDeletion(deletion, false)).resolves.toBeUndefined();
    await expect(completedCloudDeletionGeneration("google", token)).resolves.toBeNull();
    await expect(cloudDeletionReconnectState("google", token)).resolves.toMatchObject({ state: "nothing-to-delete", generation: deletion.operationId, reason: expect.stringContaining("Google") });
    await expect(resumeCloudWrites("google", token, deletion.operationId)).resolves.toBe(true);
    const release = await acquireCloudWriteLease("google", token);
    await release();
    vi.unstubAllGlobals();
  });

  it("terminalizes a verified Microsoft no-folder result and resumes writes explicitly", async () => {
    const token = `microsoft-empty-${crypto.randomUUID()}`;
    registerCloudAccount("microsoft", token, `microsoft-empty-${crypto.randomUUID()}`);
    const deletion = await suspendCloudWrites("microsoft", token);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-empty" });
      if (String(input).endsWith("/root:/Apps/Narrarium")) return new Response(null, { status: 404 });
      if (String(input).includes("/root:/Apps/Narrarium?") && String(input).includes("createdBy")) return new Response(null, { status: 404 });
      throw new Error(`Unexpected request ${String(input)}`);
    }));
    await expect(deleteNarrariumCloudData("microsoft", token, deletion)).resolves.toEqual({ deleted: false, count: 0, folderIds: [] });
    await expect(cloudDeletionReconnectState("microsoft", token)).resolves.toMatchObject({ state: "nothing-to-delete", generation: deletion.operationId, reason: expect.stringContaining("Microsoft") });
    await expect(resumeCloudWrites("microsoft", token, deletion.operationId)).resolves.toBe(true);
    const release = await acquireCloudWriteLease("microsoft", token);
    await release();
    vi.unstubAllGlobals();
  });

  it("never terminalizes an existing deletion journal from later provider absence", async () => {
    const token = `journal-absence-${crypto.randomUUID()}`;
    registerCloudAccount("microsoft", token, `journal-absence-${crypto.randomUUID()}`);
    const deletion = await suspendCloudWrites("microsoft", token);
    const target = "https://graph.microsoft.com/v1.0/me/drive/items/journaled";
    await journalCloudDeletionTargets(deletion, [{ target, itemId: "journaled", name: "settings.json", eTag: "etag", role: "ordinary" }]);
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === target && init?.method === "DELETE") return new Response(null, { status: 404 });
      throw new Error(`Provider discovery must not run after journaling: ${String(input)}`);
    }));
    await expect(deleteNarrariumCloudData("microsoft", token, deletion)).resolves.toMatchObject({ deleted: true, folderIds: ["journaled"] });
    await expect(cloudDeletionReconnectState("microsoft", token)).resolves.toBeNull();
    await completeCloudDeletion(deletion, true);
    vi.unstubAllGlobals();
  });

  it("terminalizes a fully completed Google journal after crash and reclaim without discovery", async () => {
    const token = `google-completed-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, `google-completed-${crypto.randomUUID()}`);
    const deletion = await suspendCloudWrites("google", token);
    let fetches = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches += 1;
      if (String(input).includes("/drive/v3/files/root?")) return Response.json({ id: "root-id" });
      if (String(input).includes("/drive/v3/files?") && init?.method !== "DELETE") return Response.json({ files: [{ id: "completed-google", name: "Narrarium", mimeType: "application/vnd.google-apps.folder", parents: ["root-id"], ownedByMe: true, trashed: false, appProperties: { narrariumAppFolder: "v1" } }] });
      if (String(input).endsWith("/files/completed-google") && init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${String(input)}`);
    }));
    crashNextCloudDeletionMutationAfterCompletedMarkForTests();
    await expect(deleteNarrariumCloudData("google", token, deletion)).rejects.toThrow(/durable target completion/);
    await expireCloudDeletionLeaseForTests(deletion);
    const reclaimed = await suspendCloudWrites("google", token);
    const beforeRetry = fetches;
    await expect(deleteNarrariumCloudData("google", token, reclaimed)).resolves.toMatchObject({ deleted: true, folderIds: ["completed-google"] });
    expect(fetches).toBe(beforeRetry);
    await expect(completedCloudDeletionGeneration("google", token)).resolves.toBe(deletion.operationId);
    await expect(resumeCloudWrites("google", token, deletion.operationId)).resolves.toBe(true);
    vi.unstubAllGlobals();
  });

  it("terminalizes a fully completed Microsoft journal after crash and reclaim without discovery", async () => {
    const token = `microsoft-completed-${crypto.randomUUID()}`;
    const identity = `microsoft-completed-${crypto.randomUUID()}`;
    registerCloudAccount("microsoft", token, identity);
    const deletion = await suspendCloudWrites("microsoft", token);
    let fetches = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      fetches += 1;
      const url = String(input);
      if (url.includes("/v1.0/me?$select=id")) return Response.json({ id: "graph-completed" });
      if (url.includes("/root:/Apps/Narrarium?") && url.includes("createdBy")) return Response.json({ id: "root-completed", folder: {}, createdBy: { user: { id: "graph-completed" } } });
      if (url.includes("/items/root-completed/children")) return Response.json({ value: [{ id: "marker-completed", name: ".narrarium-app-folder-v1.json", eTag: "marker-tag", file: {} }] });
      if (url.endsWith("/.narrarium-app-folder-v1.json:/content")) return Response.json({ application: "Narrarium", version: 3, provider: "microsoft", providerAccountId: identity, graphUserId: "graph-completed" });
      if (url.endsWith("/items/marker-completed") && init?.method === "DELETE") return new Response(null, { status: 204 });
      throw new Error(`Unexpected request ${url}`);
    }));
    crashNextCloudDeletionMutationAfterCompletedMarkForTests();
    await expect(deleteNarrariumCloudData("microsoft", token, deletion)).rejects.toThrow(/durable target completion/);
    await expireCloudDeletionLeaseForTests(deletion);
    const reclaimed = await suspendCloudWrites("microsoft", token);
    const beforeRetry = fetches;
    await expect(deleteNarrariumCloudData("microsoft", token, reclaimed)).resolves.toMatchObject({ deleted: true, folderIds: ["marker-completed"] });
    expect(fetches).toBe(beforeRetry);
    await expect(completedCloudDeletionGeneration("microsoft", token)).resolves.toBe(deletion.operationId);
    await expect(resumeCloudWrites("microsoft", token, deletion.operationId)).resolves.toBe(true);
    vi.unstubAllGlobals();
  });

  it("rejects nothing-to-delete transitions from a stale owner or immutable account", async () => {
    const token = `empty-stale-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, `empty-stale-${crypto.randomUUID()}`);
    const deletion = await suspendCloudWrites("google", token);
    await expect(completeCloudDeletionNothingToDelete({ ...deletion, owner: "stale-owner" }, "stale")).rejects.toThrow(/ownership/);
    await expect(completeCloudDeletionNothingToDelete({ ...deletion, id: "google:other-account" }, "other account")).rejects.toThrow(/ownership/);
    await failCloudDeletion(deletion, new Error("Test cleanup."));
  });

  it("rejects provider absence without a durable target intent", async () => {
    const token = `missing-target-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, `missing-target-${crypto.randomUUID()}`);
    const deletion = await suspendCloudWrites("google", token);
    await expect(completeCloudDeletion(deletion, false)).rejects.toThrow(/durable target intent/);
    await expect(acquireCloudWriteLease("google", token)).rejects.toThrow(/suspended/);
    await failCloudDeletion(deletion, new Error("No verified target exists."));
  });

  it("rejects target intents from stale deletion owners and fences", async () => {
    const token = `stale-target-${crypto.randomUUID()}`;
    registerCloudAccount("google", token, `stale-target-${crypto.randomUUID()}`);
    const deletion = await suspendCloudWrites("google", token);
    const request = { method: "DELETE" };
    await expect(fencedCloudDeletionMutation({ ...deletion, owner: "stale-owner" }, "https://example.test/owner", request)).rejects.toThrow(/ownership/);
    await expect(fencedCloudDeletionMutation({ ...deletion, generation: "stale-generation" }, "https://example.test/generation", request)).rejects.toThrow(/ownership/);
    await expect(fencedCloudDeletionMutation({ ...deletion, fence: deletion.fence + 1 }, "https://example.test/fence", request)).rejects.toThrow(/ownership/);
    await expect(fencedCloudDeletionMutation({ ...deletion, leaseFence: deletion.leaseFence + 1 }, "https://example.test/lease-fence", request)).rejects.toThrow(/ownership/);
    await failCloudDeletion(deletion, new Error("Test cleanup."));
  });

  it("does not clear cost or clipboard dirty state for a stale uploaded revision", () => {
    useCostsStore.setState({ dirty: true, revision: 2 });
    useCostsStore.getState().markSynced(1);
    expect(useCostsStore.getState().dirty).toBe(true);
    useClipboardStore.setState({ dirty: true, revision: 3 });
    useClipboardStore.getState().markSynced(2);
    expect(useClipboardStore.getState().dirty).toBe(true);
  });
});

async function withMicrosoftLease(token: string, run: () => Promise<void>): Promise<void> {
  const release = await acquireCloudWriteLease("microsoft", token);
  try { await run(); } finally { await release(); }
}
