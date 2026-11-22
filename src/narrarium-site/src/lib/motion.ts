/** True when the person asked the system to reduce motion (`prefers-reduced-motion: reduce`). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The `behavior` to pass to `scrollIntoView` and `scrollTo`. The global `scroll-behavior: auto` of index.css does not reach an
 * explicit `behavior: "smooth"`, so every programmatic scroll asks here instead.
 */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}
