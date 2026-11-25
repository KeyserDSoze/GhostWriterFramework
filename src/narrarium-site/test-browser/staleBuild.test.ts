import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localRuns, setLocalRuns, subscribeLocalRuns } from "@/autopilot/localRuns";
import { isStaleChunkError, noteStaleChunk } from "@/lib/staleBuild";
import { handleServiceWorkerControllerChange } from "@/pwa";
import { useAppUpdateStore } from "@/store/appUpdateStore";

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

beforeEach(() => {
  useAppUpdateStore.setState({ worker: null, version: null, promptOpen: false, stale: false });
});

afterEach(() => {
  setLocalRuns([]);
  vi.restoreAllMocks();
});

describe("a part of the app that cannot be loaded because the page is older than the site", () => {
  it("is told by the words of Chromium, Firefox, Safari and Vite, and nothing else", () => {
    expect(isStaleChunkError(new TypeError("Failed to fetch dynamically imported module: https://narrarium.net/assets/AutopilotHubPage-KerUr87E.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("error loading dynamically imported module: https://narrarium.net/assets/a.js"))).toBe(true);
    expect(isStaleChunkError(new TypeError("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError(new Error("Unable to preload CSS for /assets/index.css"))).toBe(true);
    expect(isStaleChunkError(new TypeError("Cannot read properties of undefined (reading 'title')"))).toBe(false);
    expect(isStaleChunkError("Failed to fetch dynamically imported module: x")).toBe(true);
    expect(isStaleChunkError(null)).toBe(false);
  });

  it("says once that a new version is available, and says nothing while the device is offline", () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(noteStaleChunk(new TypeError("Failed to fetch dynamically imported module: x"))).toBe(false);
    expect(useAppUpdateStore.getState()).toMatchObject({ stale: false, promptOpen: false });
    online.mockReturnValue(true);
    expect(noteStaleChunk(new TypeError("Failed to fetch dynamically imported module: x"))).toBe(true);
    expect(useAppUpdateStore.getState()).toMatchObject({ stale: true, promptOpen: true });
    useAppUpdateStore.getState().dismissPrompt();
    noteStaleChunk(new TypeError("Failed to fetch dynamically imported module: y"));
    expect(useAppUpdateStore.getState().promptOpen).toBe(false);
  });
});

describe("the autopilots that run in this tab", () => {
  it("are said by the runtime, once for every change", () => {
    const heard: string[][] = [];
    const stop = subscribeLocalRuns(() => heard.push([...localRuns()]));
    setLocalRuns(["tide", "glass", "glass"]);
    setLocalRuns(["glass", "tide"]);
    setLocalRuns(["glass"]);
    stop();
    setLocalRuns([]);
    expect(heard).toEqual([["glass", "tide"], ["glass"]]);
    expect(localRuns()).toEqual([]);
  });
});

describe("a new version that takes over the app", () => {
  it("does not reload a tab where an autopilot runs, unless the author asked for it here: the page says it is out of date", () => {
    const location = { replace: vi.fn(), reload: vi.fn() };
    expect(handleServiceWorkerControllerChange("/", location, "0.110.0", memoryStorage(), () => true)).toBe("deferred");
    expect(location.reload).not.toHaveBeenCalled();
    expect(useAppUpdateStore.getState()).toMatchObject({ stale: true, promptOpen: true });
  });

  it("reloads a tab where nothing runs, as before", () => {
    const location = { replace: vi.fn(), reload: vi.fn() };
    expect(handleServiceWorkerControllerChange("/", location, "0.110.0", memoryStorage(), () => false)).toBe("reload");
    expect(location.reload).toHaveBeenCalledTimes(1);
  });
});
