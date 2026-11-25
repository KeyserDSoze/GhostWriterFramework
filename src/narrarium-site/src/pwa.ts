import { APP_VERSION } from "@/config/version";
import { useAppUpdateStore } from "@/store/appUpdateStore";
import { isNewerAppVersion } from "@/lib/appVersion";
import {
  beginUpdateDestinationNavigation,
  clearUpdateDestinationIntentThrough,
  createUpdateDestinationIntent,
  markControllerReloadHandled,
  migrateLegacyUpdateDestinationIntent,
  patchNotesPhysicalUrl,
} from "@/pwaUpdateIntent";
import { triggerCurrentSave } from "@/store/saveStore";
import { localRuns } from "@/autopilot/localRuns";
import { noteStaleChunk } from "@/lib/staleBuild";

const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;

function workerVersion(worker: ServiceWorker, fallback: string): string {
  try {
    return new URL(worker.scriptURL).searchParams.get("v") || fallback;
  } catch {
    return fallback;
  }
}

function reportWaitingWorker(worker: ServiceWorker, fallbackVersion: string) {
  useAppUpdateStore.getState().setAvailable(worker, workerVersion(worker, fallbackVersion));
}

/** The author asked for the update in this tab: the new version taking over reloads it even while an autopilot runs here (they were told). */
let updateRequested = false;

export async function activateAvailableUpdate(openPatchNotes: boolean): Promise<boolean> {
  const { worker, version } = useAppUpdateStore.getState();
  if (!worker) return false;
  if (!await triggerCurrentSave()) return false;
  const targetVersion = version ?? workerVersion(worker, APP_VERSION);
  if (openPatchNotes) createUpdateDestinationIntent(targetVersion);
  else clearUpdateDestinationIntentThrough(targetVersion);
  updateRequested = true;
  worker.postMessage({ type: "SKIP_WAITING" });
  return true;
}

/**
 * The update the author chose: the new version that waits takes over (and the page reloads with it), or, when it already took over or the page only
 * learnt that it is out of date (a part of it could not be loaded), the page reloads. What is being edited is saved first.
 */
export async function applyUpdateNow(openPatchNotes = false): Promise<boolean> {
  if (useAppUpdateStore.getState().worker) return activateAvailableUpdate(openPatchNotes);
  if (!await triggerCurrentSave()) return false;
  window.location.reload();
  return true;
}

let appShellCachePromise: Promise<boolean> | null = null;
let appShellCached = false;

export function cacheAppShellPwaAssets(): Promise<boolean> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return Promise.resolve(false);
  if (appShellCached) return Promise.resolve(true);
  if (appShellCachePromise) return appShellCachePromise;
  appShellCachePromise = new Promise<boolean>((resolve) => {
    let channel: MessageChannel | null = null;
    let finished = false;
    const finish = (result: boolean) => { if (finished) return; finished = true; channel?.port1.close(); appShellCachePromise = null; appShellCached = result; resolve(result); };
    const timer = window.setTimeout(() => finish(false), 15_000);
    void navigator.serviceWorker.ready.then((registration) => {
      if (finished || !registration.active) { window.clearTimeout(timer); finish(false); return; }
      channel = new MessageChannel();
      channel.port1.onmessage = (event) => { window.clearTimeout(timer); finish(event.data?.failed === 0); };
      registration.active.postMessage({ type: "CACHE_APP_SHELL_ASSETS" }, [channel.port2]);
    }).catch(() => { window.clearTimeout(timer); finish(false); });
  });
  return appShellCachePromise;
}

interface BrowserLocation {
  replace(url: string): void;
  reload(): void;
}

/**
 * A new version took over the app. This tab reloads to run it, unless an autopilot runs here and the author did not ask for the update in this tab
 * (another tab's update, the first installation): a reload would stop the run, so the page only says that it is out of date, and reloads when the
 * author chooses (`deferred`).
 */
export function handleServiceWorkerControllerChange(
  baseUrl: string,
  browserLocation: BrowserLocation = window.location,
  targetVersion = useAppUpdateStore.getState().version ?? APP_VERSION,
  tabStorage: Storage = sessionStorage,
  runsHere: () => boolean = () => localRuns().length > 0,
): "patch-notes" | "reload" | "ignored" | "deferred" {
  if (!updateRequested && runsHere()) {
    useAppUpdateStore.getState().setStale();
    return "deferred";
  }
  const intent = migrateLegacyUpdateDestinationIntent(targetVersion, Date.now(), tabStorage);
  if (intent) {
    if (!beginUpdateDestinationNavigation(tabStorage)) return "ignored";
    browserLocation.replace(patchNotesPhysicalUrl(baseUrl));
    return "patch-notes";
  }
  if (!markControllerReloadHandled(targetVersion, tabStorage)) return "ignored";
  browserLocation.reload();
  return "reload";
}

export function registerServiceWorker() {
  migrateLegacyUpdateDestinationIntent(APP_VERSION);
  // A part of the app that Vite could not preload (the files of this version are gone after a deployment): the page says that it is out of date.
  window.addEventListener("vite:preloadError", (event) => { noteStaleChunk((event as Event & { payload?: unknown }).payload); });
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    handleServiceWorkerControllerChange(import.meta.env.BASE_URL || "/");
  });

  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL || "/";
    const swUrl = `${base.replace(/\/$/, "")}/sw.js?v=${encodeURIComponent(APP_VERSION)}`;
    void navigator.serviceWorker.register(swUrl, { scope: base, updateViaCache: "none" }).then((registration) => {
      let latestVersion = APP_VERSION;
      let lastVersionCheck = 0;

      if (registration.waiting) reportWaitingWorker(registration.waiting, latestVersion);

      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            reportWaitingWorker(worker, latestVersion);
          }
        });
      });

      async function checkForUpdate() {
        if (navigator.onLine === false || registration.installing) return;
        lastVersionCheck = Date.now();
        try {
          const versionUrl = `${base.replace(/\/$/, "")}/version.json?_=${Date.now()}`;
          const response = await fetch(versionUrl, { cache: "no-store" });
          if (!response.ok) return;
          const payload = await response.json() as { version?: string };
          if (!payload.version || !isNewerAppVersion(payload.version, APP_VERSION)) {
            await registration.update();
            return;
          }
          latestVersion = payload.version;
          await navigator.serviceWorker.register(
            `${base.replace(/\/$/, "")}/sw.js?v=${encodeURIComponent(latestVersion)}`,
            { scope: base, updateViaCache: "none" },
          );
        } catch {
          // Update checks are best-effort and must never interrupt the app.
        }
      }

      void checkForUpdate();
      const interval = window.setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && Date.now() - lastVersionCheck > 60_000) void checkForUpdate();
      });
      window.addEventListener("beforeunload", () => window.clearInterval(interval), { once: true });
    }).catch(() => undefined);
  });
}
