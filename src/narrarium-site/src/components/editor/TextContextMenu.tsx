import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardPaste, Copy, Scissors, Sparkles, TextCursorInput, Wand2 } from "lucide-react";
import { useClipboardStore } from "@/clipboard/clipboardStore";

export interface ImproveContext {
  improveSelection: (selection: string | null) => void;
  synonym: (selection: string) => void;
}

interface MenuState {
  open: boolean;
  x: number;
  y: number;
  selection: string;
}

export function TextContextMenu({
  targetRef,
  getValue,
  setValue,
  improve,
}: {
  targetRef: React.RefObject<HTMLTextAreaElement | null>;
  getValue: () => string;
  setValue: (next: string) => void;
  improve?: ImproveContext;
}) {
  const { t } = useTranslation();
  const { items, push } = useClipboardStore();
  const [menu, setMenu] = useState<MenuState>({ open: false, x: 0, y: 0, selection: "" });
  const [showHistory, setShowHistory] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  const selectionOf = () => {
    const el = targetRef.current;
    if (!el) return "";
    return el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0);
  };

  const openAt = (x: number, y: number) => {
    const pad = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = 230;
    const left = Math.min(x, vw - width - pad);
    const top = Math.min(y, vh - 320 - pad);
    setMenu({ open: true, x: Math.max(pad, left), y: Math.max(pad, top), selection: selectionOf() });
    setShowHistory(false);
  };

  useEffect(() => {
    const isInside = (target: EventTarget | null) => {
      const el = targetRef.current;
      return !!el && (el === target || el.contains(target as Node));
    };

    const onContextMenu = (e: MouseEvent) => {
      if (!isInside(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      targetRef.current?.focus();
      openAt(e.clientX, e.clientY);
    };
    const onTouchStart = (e: TouchEvent) => {
      if (!isInside(e.target)) return;
      if (longPressTimer.current) clearTimeout(longPressTimer.current);
      const touch = e.touches[0];
      const x = touch.clientX;
      const y = touch.clientY;
      longPressTimer.current = setTimeout(() => openAt(x, y), 500);
    };
    const cancelLongPress = () => { if (longPressTimer.current) clearTimeout(longPressTimer.current); };

    document.addEventListener("contextmenu", onContextMenu, true);
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", cancelLongPress);
    document.addEventListener("touchmove", cancelLongPress, { passive: true });
    return () => {
      document.removeEventListener("contextmenu", onContextMenu, true);
      document.removeEventListener("touchstart", onTouchStart);
      document.removeEventListener("touchend", cancelLongPress);
      document.removeEventListener("touchmove", cancelLongPress);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetRef]);

  useEffect(() => {
    if (!menu.open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if ("button" in e && (e as MouseEvent).button === 2) return;
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu((m) => ({ ...m, open: false }));
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMenu((m) => ({ ...m, open: false })); };
    window.addEventListener("mousedown", close);
    window.addEventListener("touchstart", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("touchstart", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu.open]);

  const close = () => setMenu((m) => ({ ...m, open: false }));

  const replaceSelection = (text: string) => {
    const el = targetRef.current;
    if (!el) return;
    const start = el.selectionStart ?? 0;
    const end = el.selectionEnd ?? 0;
    const value = getValue();
    setValue(value.slice(0, start) + text + value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start, start + text.length);
    });
  };

  const insertAtCursor = (text: string) => {
    const el = targetRef.current;
    if (!el) { setValue(getValue() + text); return; }
    replaceSelection(text);
  };

  const doCopy = async () => {
    const sel = selectionOf();
    if (!sel) return;
    try { await navigator.clipboard.writeText(sel); } catch { /* ignore */ }
    push(sel, "editor");
    close();
  };
  const doCut = async () => {
    const sel = selectionOf();
    if (!sel) return;
    try { await navigator.clipboard.writeText(sel); } catch { /* ignore */ }
    push(sel, "editor");
    replaceSelection("");
    close();
  };
  const doPaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) insertAtCursor(text);
    } catch { /* clipboard read may be blocked */ }
    close();
  };
  const doSelectAll = () => {
    const el = targetRef.current;
    if (el) { el.focus(); el.select(); }
    close();
  };

  const wordCount = menu.selection.trim() ? menu.selection.trim().split(/\s+/).length : 0;
  const canSynonym = !!improve && wordCount >= 1 && wordCount <= 3;

  if (!menu.open) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-[60] w-[230px] overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-2xl"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {showHistory ? (
        <div className="max-h-72 overflow-auto">
          <button className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent" onClick={() => setShowHistory(false)}>← {t("ctx.back")}</button>
          {items.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted-foreground">{t("ctx.noHistory")}</p>
          ) : items.map((entry) => (
            <button key={entry.id} className="block w-full truncate rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent" onClick={() => { insertAtCursor(entry.text); close(); }} title={entry.text}>
              {entry.text.length > 60 ? entry.text.slice(0, 60) + "…" : entry.text}
            </button>
          ))}
        </div>
      ) : (
        <div className="flex flex-col">
          {improve && (
            <MenuItem icon={<Wand2 className="h-4 w-4" />} label={menu.selection ? t("ctx.improveSelection") : t("ctx.improveAll")} onClick={() => { improve.improveSelection(menu.selection || null); close(); }} />
          )}
          {canSynonym && (
            <MenuItem icon={<Sparkles className="h-4 w-4" />} label={t("ctx.synonym")} onClick={() => { improve!.synonym(menu.selection); close(); }} />
          )}
          {improve && <div className="my-1 h-px bg-border" />}
          <MenuItem icon={<TextCursorInput className="h-4 w-4" />} label={t("ctx.selectAll")} onClick={doSelectAll} />
          <MenuItem icon={<Copy className="h-4 w-4" />} label={t("ctx.copy")} onClick={() => void doCopy()} disabled={!menu.selection} />
          <MenuItem icon={<Scissors className="h-4 w-4" />} label={t("ctx.cut")} onClick={() => void doCut()} disabled={!menu.selection} />
          <MenuItem icon={<ClipboardPaste className="h-4 w-4" />} label={t("ctx.paste")} onClick={() => void doPaste()} />
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
