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

export async function activateAvailableUpdate(openPatchNotes: boolean): Promise<boolean> {
  const { worker, version } = useAppUpdateStore.getState();
  if (!worker) return false;
  if (!await triggerCurrentSave()) return false;
  const targetVersion = version ?? workerVersion(worker, APP_VERSION);
  if (openPatchNotes) createUpdateDestinationIntent(targetVersion);
  else clearUpdateDestinationIntentThrough(targetVersion);
  worker.postMessage({ type: "SKIP_WAITING" });
  return true;
}

interface BrowserLocation {
  replace(url: string): void;
  reload(): void;
}

export function handleServiceWorkerControllerChange(
  baseUrl: string,
  browserLocation: BrowserLocation = window.location,
  targetVersion = useAppUpdateStore.getState().version ?? APP_VERSION,
  tabStorage: Storage = sessionStorage,
): "patch-notes" | "reload" | "ignored" {
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
