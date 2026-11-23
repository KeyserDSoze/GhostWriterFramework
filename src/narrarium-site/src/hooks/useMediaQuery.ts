import { useSyncExternalStore } from "react";

/** Whether the screen matches `query` now, followed as it changes (a phone turned sideways). False where the browser cannot tell (no `matchMedia`). */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => undefined;
      const list = window.matchMedia(query);
      list.addEventListener?.("change", notify);
      return () => list.removeEventListener?.("change", notify);
    },
    () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches,
    () => false,
  );
}
