import { useLayoutEffect, type RefObject } from "react";

/**
 * The names of the rooms a part of the screen can keep, as custom properties of the page: `--top-reserve` is what sticks to the top (the
 * band of the autopilot), `--bottom-reserve` what sits at the bottom of the screen for good (its bar of actions), `--dock-reserve` the live panel
 * while it is open. The layout reads them: it scrolls its anchors clear of the top, it pads the end of the page by the bottom ones, and the
 * floating buttons stand above `--bottom-reserve`. The live panel has a name of its own so that it is not lifted by its own height.
 */
export type ReserveName = "--top-reserve" | "--bottom-reserve" | "--dock-reserve";

/**
 * Tell the whole page how tall `ref` is, in pixels, under `name`, for as long as it is on the screen and `active`. One part keeps one name:
 * when it goes away the room is given back.
 */
export function useReserveSpace(ref: RefObject<HTMLElement | null>, name: ReserveName, active = true): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!active || !element || typeof document === "undefined") return undefined;
    const style = document.documentElement.style;
    const publish = () => style.setProperty(name, `${Math.ceil(element.getBoundingClientRect().height)}px`);
    publish();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(publish) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      style.removeProperty(name);
    };
  }, [ref, name, active]);
}
