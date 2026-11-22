import { useLayoutEffect, useState } from "react";

export interface ContainerWidth {
  /** The width in pixels, kept up to date; `null` where the browser cannot tell (as in a test) or the element has no width. */
  width: number | null;
  /** The element was measured, or measuring it was tried: from then on `width` is what the element has, and a layout that depends on it will not change again at the first draw. */
  measured: boolean;
}

/**
 * How wide an element is. The width of the page that holds a thing, not the one of the screen: the same screen has less room for a page when
 * the sidebar and the dossier are open. Pass the element itself (kept in a state, as the target of a callback ref), so that an element that is
 * drawn later is measured too.
 */
export function useContainerWidth(element: HTMLElement | null): ContainerWidth {
  const [state, setState] = useState<ContainerWidth>({ width: null, measured: false });
  useLayoutEffect(() => {
    if (!element) return undefined;
    const read = (value: number) => setState((current) => {
      const width = value > 0 ? Math.round(value) : null;
      return current.measured && current.width === width ? current : { width, measured: true };
    });
    read(element.getBoundingClientRect().width);
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver((entries) => read(entries[entries.length - 1]?.contentRect.width ?? element.getBoundingClientRect().width));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return state;
}
