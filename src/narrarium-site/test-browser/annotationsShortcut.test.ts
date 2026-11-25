import { describe, expect, it } from "vitest";
import { annotateShortcutLabel, isAnnotateShortcut, isMacPlatform, isTypingTarget } from "@/annotations/shortcut";

describe("the shortcut that annotates", () => {
  const keys = (patch: Partial<KeyboardEvent>) => ({ key: "", code: "", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...patch });

  it("is ⌥⌘A on a Mac, by its key or, when Option changes the character, by its place", () => {
    expect(isAnnotateShortcut(keys({ key: "a", code: "KeyA", metaKey: true, altKey: true }), true)).toBe(true);
    expect(isAnnotateShortcut(keys({ key: "å", code: "KeyA", metaKey: true, altKey: true }), true)).toBe(true);
    // ⌥⌘M minimizes every window of the app on a Mac: it is not the shortcut there.
    expect(isAnnotateShortcut(keys({ key: "µ", code: "KeyM", metaKey: true, altKey: true }), true)).toBe(false);
    expect(isAnnotateShortcut(keys({ key: "a", code: "KeyA", metaKey: true, altKey: true, shiftKey: true }), true)).toBe(false);
    expect(isAnnotateShortcut(keys({ key: "a", code: "KeyA", metaKey: true }), true)).toBe(false);
    expect(isAnnotateShortcut(keys({ key: "a", code: "KeyA", metaKey: true, altKey: true, ctrlKey: true }), true)).toBe(false);
    expect(annotateShortcutLabel(true)).toBe("⌥⌘A");
  });

  it("is Ctrl+Alt+M elsewhere, AltGr included, and never Ctrl+M", () => {
    expect(isAnnotateShortcut(keys({ key: "m", code: "KeyM", ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(isAnnotateShortcut(keys({ key: "M", code: "Semicolon", ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(isAnnotateShortcut(keys({ key: "µ", code: "KeyM", ctrlKey: true, altKey: true }), false)).toBe(true);
    expect(isAnnotateShortcut(keys({ key: "m", code: "KeyM", ctrlKey: true }), false)).toBe(false);
    expect(isAnnotateShortcut(keys({ key: "m", code: "KeyM", metaKey: true, altKey: true }), false)).toBe(false);
    expect(isAnnotateShortcut(keys({ key: "m", code: "KeyM", ctrlKey: true, altKey: true, shiftKey: true }), false)).toBe(false);
    expect(annotateShortcutLabel(false)).toBe("Ctrl+Alt+M");
  });

  it("knows a Mac, an iPad and an iPhone from the platform", () => {
    expect(isMacPlatform("MacIntel")).toBe(true);
    expect(isMacPlatform("macOS")).toBe(true);
    expect(isMacPlatform("iPad")).toBe(true);
    expect(isMacPlatform("Win32")).toBe(false);
    expect(isMacPlatform("Linux x86_64")).toBe(false);
  });

  it("is never taken where the keys type", () => {
    document.body.innerHTML = `
      <input id="field" /><textarea id="area"></textarea><select id="choice"><option>a</option></select>
      <div contenteditable="true"><span id="editable">text</span></div><div contenteditable="false"><span id="fixed">text</span></div>
      <article id="reader"><p id="prose">The gate stood open.</p></article><button id="button">Next</button>`;
    for (const id of ["field", "area", "choice", "editable"]) expect(isTypingTarget(document.getElementById(id)), id).toBe(true);
    for (const id of ["fixed", "prose", "button"]) expect(isTypingTarget(document.getElementById(id)), id).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget(window)).toBe(false);
    document.body.innerHTML = "";
  });
});
