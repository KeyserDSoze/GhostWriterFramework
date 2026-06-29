import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardPaste, Copy, Scissors, Sparkles, TextCursorInput, Wand2 } from "lucide-react";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { useProseEditorStore, type ProseEditorActions } from "@/components/editor/proseEditorStore";

type Editable = HTMLTextAreaElement | HTMLInputElement;

function isEditable(el: EventTarget | null): el is Editable {
  if (!(el instanceof HTMLElement)) return false;
  if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
  if (el instanceof HTMLInputElement) {
    const t = el.type;
    return !el.disabled && !el.readOnly && (t === "text" || t === "search" || t === "url" || t === "email" || t === "tel" || t === "password" || t === "number" || t === "");
  }
  return false;
}

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  editable: Editable | null;
  prose?: ProseEditorActions;
  selection: string;
}

const CLOSED: MenuState = { open: false, x: 0, y: 0, editable: null, selection: "" };

export function GlobalContextMenu() {
  const { t } = useTranslation();
  const { items, push } = useClipboardStore();
  const forElement = useProseEditorStore((s) => s.forElement);
  const [menu, setMenu] = useState<MenuState>(CLOSED);
  const [showHistory, setShowHistory] = useState(false);
  const longPress = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selectionString = (editable: Editable | null) => {
    if (editable) return editable.value.slice(editable.selectionStart ?? 0, editable.selectionEnd ?? 0);
    return window.getSelection()?.toString() ?? "";
  };

  const openAt = (x: number, y: number, target: EventTarget | null) => {
    const editable = isEditable(target) ? target : null;
    const sel = selectionString(editable);
    // Don't open custom menu when there is nothing actionable (no editable + no selection).
    if (!editable && !sel.trim()) return false;
    const pad = 8;
    const width = 234;
    const left = Math.min(x, window.innerWidth - width - pad);
    const top = Math.min(y, window.innerHeight - 320 - pad);
    setMenu({ open: true, x: Math.max(pad, left), y: Math.max(pad, top), editable, prose: editable ? forElement(editable) : undefined, selection: sel });
    setShowHistory(false);
    return true;
  };

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.("[data-no-context-menu]")) return;
      const opened = openAt(e.clientX, e.clientY, e.target);
      if (opened) { e.preventDefault(); e.stopPropagation(); }
    };

    let startX = 0;
    let startY = 0;
    let moved = false;
    const LONG_PRESS_MS = 800;
    const MOVE_TOLERANCE = 10;

    const hasActiveSelection = () => {
      const sel = window.getSelection();
      return !!sel && !sel.isCollapsed && (sel.toString().trim().length > 0);
    };

    const onTouchStart = (e: TouchEvent) => {
      if (e.touches.length > 1) { cancel(); return; }
      const target = e.target;
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      moved = false;
      // If the user already has a text selection (dragging handles), don't hijack the gesture.
      if (hasActiveSelection()) return;
      if (longPress.current) clearTimeout(longPress.current);
      longPress.current = setTimeout(() => {
        if (!moved) openAt(startX, startY, target);
      }, LONG_PRESS_MS);
    };
    const onTouchMove = (e: TouchEvent) => {
      const touch = e.touches[0];
      if (!touch) return;
      if (Math.abs(touch.clientX - startX) > MOVE_TOLERANCE || Math.abs(touch.clientY - startY) > MOVE_TOLERANCE) {
        moved = true;
        cancel();
      }
    };
    function cancel() { if (longPress.current) { clearTimeout(longPress.current); longPress.current = null; } }

    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", cancel);
    document.addEventListener("touchcancel", cancel);
    document.addEventListener("touchmove", onTouchMove, { passive: true });
    return () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", cancel);
      document.removeEventListener("touchcancel", cancel);
      document.removeEventListener("touchmove", onTouchMove);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!menu.open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if ("button" in e && (e as MouseEvent).button === 2) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(CLOSED);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu(CLOSED); };
    window.addEventListener("mousedown", close);
    window.addEventListener("touchstart", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", () => setMenu(CLOSED));
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("touchstart", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu.open]);

  const close = () => setMenu(CLOSED);

  const replaceSelection = (text: string) => {
    const el = menu.editable;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const value = el.value;
    const next = value.slice(0, start) + text + value.slice(end);
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
    setter?.call(el, next);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + text.length, start + text.length);
    });
  };

  const doCopy = async () => {
    if (!menu.selection) return;
    try { await navigator.clipboard.writeText(menu.selection); } catch { /* ignore */ }
    push(menu.selection);
    close();
  };
  const doCut = async () => {
    if (!menu.editable || !menu.selection) return;
    try { await navigator.clipboard.writeText(menu.selection); } catch { /* ignore */ }
    push(menu.selection);
    replaceSelection("");
    close();
  };
  const doPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) replaceSelection(text);
    } catch { /* clipboard read blocked */ }
    close();
  };
  const doSelectAll = () => {
    const el = menu.editable;
    if (el) { el.focus(); el.select(); }
    close();
  };

  const wordCount = menu.selection.trim() ? menu.selection.trim().split(/\s+/).length : 0;
  const canSynonym = !!menu.prose && wordCount >= 1 && wordCount <= 3;

  if (!menu.open) return null;

  return (
    <div
      ref={menuRef}
      data-no-context-menu
      className="fixed z-[70] w-[234px] overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-2xl"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {showHistory ? (
        <div className="max-h-72 overflow-auto">
          <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent" onClick={() => setShowHistory(false)}>← {t("ctx.back")}</button>
          {items.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">{t("ctx.noHistory")}</p>
          ) : items.map((entry) => (
            <button
              key={entry.id}
              className="block w-full truncate rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent disabled:opacity-40"
              disabled={!menu.editable}
              onClick={() => { replaceSelection(entry.text); close(); }}
              title={entry.text}
            >
              {entry.text.length > 60 ? entry.text.slice(0, 60) + "…" : entry.text}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col">
          {menu.prose && (
            <>
              <MenuItem icon={<Wand2 className="h-4 w-4" />} label={menu.selection ? t("ctx.improveSelection") : t("ctx.improveAll")} onClick={() => { menu.prose!.improve(menu.selection || null); close(); }} />
              {canSynonym && <MenuItem icon={<Sparkles className="h-4 w-4" />} label={t("ctx.synonym")} onClick={() => { menu.prose!.synonym(menu.selection); close(); }} />}
              <div className="my-1 h-px bg-border" />
            </>
          )}
          {menu.editable && <MenuItem icon={<TextCursorInput className="h-4 w-4" />} label={t("ctx.selectAll")} onClick={doSelectAll} />}
          <MenuItem icon={<Copy className="h-4 w-4" />} label={t("ctx.copy")} onClick={() => void doCopy()} disabled={!menu.selection} />
          {menu.editable && <MenuItem icon={<Scissors className="h-4 w-4" />} label={t("ctx.cut")} onClick={() => void doCut()} disabled={!menu.selection} />}
          {menu.editable && <MenuItem icon={<ClipboardPaste className="h-4 w-4" />} label={t("ctx.paste")} onClick={() => void doPaste()} />}
          <MenuItem icon={<ClipboardPaste className="h-4 w-4" />} label={t("ctx.specialPaste")} onClick={() => setShowHistory(true)} />
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      {icon}{label}
    </button>
  );
}
