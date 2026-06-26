import { APP_VERSION } from "@/config/version";

declare global {
  interface WindowEventMap {
    "narrarium:update-available": CustomEvent<{ worker: ServiceWorker; version: string }>;
  }
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
      void registration.update();
      registration.addEventListener("updatefound", () => {
        const worker = registration.installing;
        if (!worker) return;
        worker.addEventListener("statechange", () => {
          if (worker.state === "installed" && navigator.serviceWorker.controller) {
            window.dispatchEvent(new CustomEvent("narrarium:update-available", { detail: { worker, version: APP_VERSION } }));
          }
        });
      });
    }).catch(() => undefined);
  });
}
