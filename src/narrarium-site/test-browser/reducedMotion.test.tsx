import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import i18n from "@/i18n";
import { RouteLoadingFallback } from "@/components/layout/RouteLoadingFallback";
import { prefersReducedMotion, scrollBehavior } from "@/lib/motion";

const originalMatchMedia = window.matchMedia;

/** jsdom has no matchMedia: answer the one query this code base asks about motion. */
function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: reduce && /prefers-reduced-motion:\s*reduce/.test(query),
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

afterEach(async () => {
  cleanup();
  window.matchMedia = originalMatchMedia;
  await i18n.changeLanguage("en");
});

describe("the main loading screen (route fallback) with and without reduced motion", () => {
  for (const reduce of [false, true]) {
    for (const [language, text] of [["en", "Loading…"], ["it", "Caricamento…"]] as const) {
      it(`${language}, ${reduce ? "reduced motion" : "full motion"}: a status region with the loading text and a decorative ring`, async () => {
        setReducedMotion(reduce);
        await i18n.changeLanguage(language);
        const { container } = render(<RouteLoadingFallback />);

        const status = screen.getByRole("status");
        expect(status).toHaveAttribute("aria-busy", "true");
        expect(status).toHaveAttribute("aria-live", "polite");
        // The words are the signal that survives when the ring stands still.
        expect(within(status).getByText(text)).toBeVisible();

        const ring = container.querySelector("[aria-hidden='true']") as HTMLElement;
        expect(ring).not.toBeNull();
        expect(ring.textContent).toBe("");
        // Still, it is a track with one dark arc: recognisable as a loader without turning.
        for (const klass of ["rounded-full", "border-2", "border-primary/30", "border-t-primary"]) expect(ring).toHaveClass(klass);
        expect(ring).toHaveClass("animate-spin");
        // Nothing takes the ring away when motion is reduced: the stylesheet only stops it.
        expect(container.innerHTML).not.toMatch(/motion-reduce:(hidden|invisible|sr-only)/);
      });
    }
  }
});

describe("programmatic scrolling", () => {
  it("is smooth by default and instant when the person asked for reduced motion", () => {
    setReducedMotion(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe("smooth");
    setReducedMotion(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe("auto");
  });

  it("falls back to smooth where the browser cannot answer the question", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe("smooth");
  });
});
