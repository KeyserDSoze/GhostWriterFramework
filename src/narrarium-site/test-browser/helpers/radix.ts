import { fireEvent, screen, within } from "@testing-library/react";

/** What Radix needs and jsdom lacks. */
export function polyfillRadix(): void {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.scrollIntoView ??= () => undefined;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => undefined;
  proto.releasePointerCapture ??= () => undefined;
}

/** Opens a Select the way a keyboard does (Radix opens on pointer events only for a real mouse) and returns its list. */
export function openSelect(trigger: HTMLElement): HTMLElement {
  fireEvent.keyDown(trigger, { key: "Enter" });
  return screen.getByRole("listbox");
}

export function optionNames(trigger: HTMLElement): string[] {
  const listbox = openSelect(trigger);
  const names = within(listbox).getAllByRole("option").map((option) => option.textContent ?? "");
  fireEvent.keyDown(listbox, { key: "Escape" });
  return names;
}

export function chooseOption(trigger: HTMLElement, name: string | RegExp): void {
  const listbox = openSelect(trigger);
  fireEvent.keyDown(within(listbox).getByRole("option", { name }), { key: "Enter" });
}

export function openMenu(trigger: HTMLElement): HTMLElement {
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  return screen.getByRole("menu");
}

export function chooseMenuItem(trigger: HTMLElement, name: string | RegExp): void {
  const menu = openMenu(trigger);
  fireEvent.click(within(menu).getByRole("menuitem", { name }));
}
