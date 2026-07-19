import { APP_VERSION } from "@/config/version";
import { useAppUpdateStore } from "@/store/appUpdateStore";
import { isNewerAppVersion } from "@/lib/appVersion";

export const OPEN_PATCH_NOTES_AFTER_UPDATE_KEY = "narrarium-open-patch-notes-after-update";
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

export function activateAvailableUpdate(openPatchNotes: boolean) {
  const worker = useAppUpdateStore.getState().worker;
  if (!worker) return;
  if (openPatchNotes) sessionStorage.setItem(OPEN_PATCH_NOTES_AFTER_UPDATE_KEY, "1");
  else sessionStorage.removeItem(OPEN_PATCH_NOTES_AFTER_UPDATE_KEY);
  worker.postMessage({ type: "SKIP_WAITING" });
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;

  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    const base = import.meta.env.BASE_URL || "/";
    const swUrl = `${base.replace(/\/$/, "")}/sw.js?v=${encodeURIComponent(APP_VERSION)}`;
    void navigator.serviceWorker.register(swUrl, { scope: base }).then((registration) => {
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
            { scope: base },
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
