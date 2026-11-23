import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

/**
 * The commands that point at a part of a page (a card, a field) do it with a link to `#its-id`. The router does not scroll to it by itself,
 * so the page does: the part comes into view and takes the focus, which is where a keyboard or a screen reader starts reading. Nothing is
 * followed before the page is `ready`; a part that is drawn a moment later (the panel of a tab that has just been opened, `dependsOn`) is
 * looked for during a few frames, and a link is followed once.
 */
export function useScrollToHash(ready: boolean, dependsOn: string): void {
  const location = useLocation();
  const followed = useRef<string | null>(null);
  useEffect(() => {
    const id = decodeURIComponent(location.hash.replace(/^#/, ""));
    const visit = `${location.key}:${id}`;
    if (!id || !ready || followed.current === visit) return undefined;
    let frame = 0;
    const look = (frames: number) => {
      const element = document.getElementById(id);
      // A part inside a tab that is not shown is looked for again: it is shown by the page a moment later.
      if (element && !element.closest("[hidden]")) {
        followed.current = visit;
        element.scrollIntoView?.({ block: "start" });
        element.focus({ preventScroll: true });
      } else if (frames > 0 && typeof requestAnimationFrame === "function") {
        frame = requestAnimationFrame(() => look(frames - 1));
      }
    };
    look(10);
    return () => { if (frame) cancelAnimationFrame(frame); };
  }, [location.hash, location.key, ready, dependsOn]);
}
