import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

/** The screens where the floating buttons step aside: the layout of a phone (narrow) and every touch screen, whose keyboard covers half of it. */
const STEP_ASIDE_SCREENS = "(max-width: 1023px), (pointer: coarse)";
/** The kinds of `<input>` a phone opens its keyboard for. */
const TEXT_INPUT = /^(text|search|email|url|tel|password|number|date|datetime-local|month|time|week)$/;
/** The keys that move the focus from one control to the next. */
const MOVING_KEYS = /^(Tab|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown)$/;
/** How long the buttons wait before coming back when the focus leaves for nowhere: a field that takes it again at once keeps them aside. */
const COME_BACK_MS = 50;

const ASIDE: CSSProperties = { opacity: 0, pointerEvents: "none" };

/** Whether `element` is written in: a field of text, or an editor. */
function takesText(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) return false;
  if (element.isContentEditable || element.closest("[contenteditable='true'], [contenteditable='']")) return true;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) return TEXT_INPUT.test(element.type) && !element.readOnly && !element.disabled;
  return false;
}

/**
 * Whether the floating buttons should step aside now: on a phone or a touch screen, while the focus is on a field of the page that is being
 * written in (the keyboard is open), or on any control of the page that the keyboard reached (WCAG 2.2, 2.4.11: a focused control is never
 * hidden under them). A field of a dialog, of the dossier or of a floating panel does not count: it is not under them.
 */
function useStepAside(): boolean {
  const [aside, setAside] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;
    let keyboard = false;
    let timer: number | undefined;
    const wants = (element: Element | null) => Boolean(element?.closest("main")) && window.matchMedia(STEP_ASIDE_SCREENS).matches && (takesText(element) || keyboard);
    const decideLater = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setAside(wants(document.activeElement)), COME_BACK_MS);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (MOVING_KEYS.test(event.key)) keyboard = true; };
    const onPointerDown = () => {
      keyboard = false;
      // A tap may take the focus from a field without giving it to anything (or remove the field): look again once it is done.
      decideLater();
    };
    const onFocusIn = (event: FocusEvent) => {
      window.clearTimeout(timer);
      setAside(wants(event.target as Element | null));
    };
    // Towards another control, its focusin decides; towards nowhere, the buttons come back unless a field takes the focus again at once.
    const onFocusOut = (event: FocusEvent) => { if (!event.relatedTarget) decideLater(); };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
    };
  }, []);
  return aside;
}

/**
 * The floating buttons of the app (the book actions, the Copilot, the autopilot and its mini-player), which step aside while the author writes
 * in a field of the page on a phone, and come back when the field is left. Aside they are transparent and let a tap through to the page, but they
 * stay in the order of the Tab key: reached with it, they come back.
 */
export function FloatingLayers({ children }: { children: ReactNode }) {
  const aside = useStepAside();
  return aside
    ? <div data-floating-layers="" data-stepped-aside="" style={ASIDE}>{children}</div>
    : <div data-floating-layers="" className="contents">{children}</div>;
}
