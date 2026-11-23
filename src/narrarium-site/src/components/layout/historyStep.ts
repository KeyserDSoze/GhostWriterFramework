import { useCallback, useEffect, useRef, type MouseEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";

/** The mark of the step a sheet over the screen adds to the history while it is open (its value names the sheet), so that the back gesture closes it. */
export const SHEET_STEP = "narrariumSheet";

/** Whether the state of a history entry is the step of an open sheet (of `name`, when it is given). */
export function isSheetStep(state: unknown, name?: string): boolean {
  if (!state || typeof state !== "object") return false;
  const value = (state as Record<string, unknown>)[SHEET_STEP];
  return name === undefined ? typeof value === "string" : value === name;
}

type Stage = "idle" | "pushing" | "on" | "leaving";

/**
 * A sheet over the whole screen of a phone (a panel, a window, the mini-player) closes with the back gesture, as the platform's own sheets do,
 * instead of leaving the page under it. While it is open the history has one more step: the same page, without its hash and its state (what the
 * page did for them is not done again), which back takes; closed by its own controls, the sheet gives the step back. A link of the sheet takes the
 * place of the step: back from where it leads goes to the page before the sheet.
 *
 * Returns the handler of the clicks on the links of the sheet (`onClickCapture` of its content).
 */
export function useBackGestureClose(open: boolean, close: () => void, name: string): (event: MouseEvent<HTMLElement>) => void {
  const navigate = useNavigate();
  const location = useLocation();
  const onStep = isSheetStep(location.state, name);
  const stage = useRef<Stage>("idle");
  const closeRef = useRef(close);
  closeRef.current = close;
  const where = useRef("");
  where.current = `${location.pathname}${location.search}`;

  useEffect(() => {
    if (open) {
      if (stage.current === "idle" || stage.current === "leaving") {
        if (onStep) {
          stage.current = "on";
          return;
        }
        stage.current = "pushing";
        navigate(where.current, { state: { [SHEET_STEP]: name } });
        return;
      }
      if (stage.current === "pushing" && onStep) stage.current = "on";
      else if (stage.current === "on" && !onStep) {
        // The back gesture took the step: the sheet closes, the page stays.
        stage.current = "idle";
        closeRef.current();
      }
      return;
    }
    // Closed by its own controls: the step goes back, at once or as soon as it is there.
    if (stage.current === "on" && onStep) {
      stage.current = "idle";
      navigate(-1);
    } else if (stage.current === "pushing") {
      stage.current = "leaving";
    } else if (stage.current === "leaving" && onStep) {
      stage.current = "idle";
      navigate(-1);
    }
  }, [open, onStep, name, navigate]);

  // Unmounted while open on its step (a sheet that goes away with what showed it, once closed by its own control): the step goes back.
  useEffect(() => () => {
    if (stage.current !== "on") return;
    stage.current = "idle";
    navigate(-1);
  }, [navigate]);

  return useCallback((event: MouseEvent<HTMLElement>) => {
    const link = (event.target as Element | null)?.closest?.("a[href]");
    if (!(link instanceof HTMLAnchorElement) || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === "_blank") return;
    const url = new URL(link.href, window.location.href);
    if (url.origin !== window.location.origin || stage.current !== "on") return;
    // The link takes the place of the step of the sheet, and the sheet closes without giving the step back (the address of a link has the base of the app).
    event.preventDefault();
    stage.current = "idle";
    closeRef.current();
    const base = (import.meta.env.BASE_URL ?? "/").replace(/\/$/, "");
    const path = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) || "/" : url.pathname;
    navigate(`${path}${url.search}${url.hash}`, { replace: true });
  }, [navigate]);
}
