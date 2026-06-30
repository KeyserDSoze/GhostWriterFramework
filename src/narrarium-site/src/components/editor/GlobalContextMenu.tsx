import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { ClipboardPaste, Copy, Image as ImageIcon, Save, Scissors, Sparkles, TextCursorInput, Wand2 } from "lucide-react";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { useProseEditorStore, type ProseEditorActions } from "@/components/editor/proseEditorStore";
import { useContextualActions } from "@/hooks/useContextualActions";
import { useSaveStore } from "@/store/saveStore";
import { AssetImageDialog } from "@/components/book/AssetImageDialog";

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
  const navigate = useNavigate();
  const { items, push } = useClipboardStore();
  const forElement = useProseEditorStore((s) => s.forElement);
  const { actions, hasBookActions, imageProps } = useContextualActions();
  const saveReg = useSaveStore((s) => s.current);
  const [menu, setMenu] = useState<MenuState>(CLOSED);
  const [showHistory, setShowHistory] = useState(false);
  const [fab, setFab] = useState<{ x: number; y: number; editable: Editable | null } | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Whether the menu can show contextual (non-text) actions at all.
  const hasContextActions = actions.length > 0 || hasBookActions || Boolean(saveReg);
  // Contextual actions are only useful when NOT working on a text selection.
  const showContextActions = hasContextActions && !menu.selection.trim();

  const selectionString = (editable: Editable | null) => {
    if (editable) return editable.value.slice(editable.selectionStart ?? 0, editable.selectionEnd ?? 0);
    return window.getSelection()?.toString() ?? "";
  };

  const openAt = (x: number, y: number, target: EventTarget | null) => {
    const editable = isEditable(target) ? target : null;
    const sel = selectionString(editable);
    // Open when there is something actionable: an editable, a selection, or contextual actions.
    if (!editable && !sel.trim() && !hasContextActions) return false;
    const pad = 8;
    const width = 234;
    const left = Math.min(x, window.innerWidth - width - pad);
    const top = Math.min(y, window.innerHeight - 320 - pad);
    setMenu({ open: true, x: Math.max(pad, left), y: Math.max(pad, top), editable, prose: editable ? forElement(editable) : undefined, selection: sel });
    setShowHistory(false);
    setFab(null);
    return true;
  };

  // ── Desktop: right-click ───────────────────────────────────────────────────
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.("[data-no-context-menu]")) return;
      const opened = openAt(e.clientX, e.clientY, e.target);
      if (opened) { e.preventDefault(); e.stopPropagation(); }
    };
    document.addEventListener("contextmenu", onContextMenu, true);
    return () => document.removeEventListener("contextmenu", onContextMenu, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Mobile/touch: floating action button on text selection ─────────────────
  useEffect(() => {
    const isTouch = matchMedia("(pointer: coarse)").matches || "ontouchstart" in window;
    if (!isTouch) return;

    const update = () => {
      if (menu.open) { setFab(null); return; }
      const active = document.activeElement;
      const editable = isEditable(active) ? active : null;

      // Editable field with a selected range
      if (editable && (editable.selectionEnd ?? 0) > (editable.selectionStart ?? 0)) {
        const rect = editable.getBoundingClientRect();
        setFab({ x: Math.min(rect.right - 24, window.innerWidth - 60), y: Math.max(56, rect.top - 8), editable });
        return;
      }

      // Non-editable selected text
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim().length > 0 && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        if (r.width || r.height) {
          setFab({ x: Math.min(r.right, window.innerWidth - 60), y: Math.max(56, r.top - 8), editable: null });
          return;
        }
      }
      setFab(null);
    };

    const onSelectionChange = () => window.setTimeout(update, 0);
    const onScroll = () => setFab(null);
    document.addEventListener("selectionchange", onSelectionChange);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      window.removeEventListener("scroll", onScroll, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu.open]);

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

  // After the menu renders, nudge it up/left if it overflows the viewport.
  useLayoutEffect(() => {
    if (!menu.open || !menuRef.current) return;
    const pad = 8;
    const rect = menuRef.current.getBoundingClientRect();
    let nextX = menu.x;
    let nextY = menu.y;
    if (rect.bottom > window.innerHeight - pad) nextY = Math.max(pad, window.innerHeight - rect.height - pad);
    if (rect.right > window.innerWidth - pad) nextX = Math.max(pad, window.innerWidth - rect.width - pad);
    if (nextX !== menu.x || nextY !== menu.y) setMenu((m) => ({ ...m, x: nextX, y: nextY }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu.open, menu.x, menu.y, showContextActions, showHistory]);

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

  const openFromFab = () => {
    if (!fab) return;
    const target: EventTarget = fab.editable ?? document.body;
    fab.editable?.focus?.();
    openAt(Math.min(fab.x, window.innerWidth - 244), fab.y + 36, target);
  };

  return (
    <>
      {fab && !menu.open && (
        <button
          type="button"
          data-no-context-menu
          onMouseDown={(e) => e.preventDefault()}
          onClick={openFromFab}
          className="fixed z-[65] flex h-10 w-10 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xl"
          style={{ left: Math.max(8, Math.min(fab.x, window.innerWidth - 48)), top: fab.y - 44 }}
          aria-label={t("ctx.textActions")}
        >
          <Wand2 className="h-5 w-5" />
        </button>
      )}

      {menu.open && (
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
              {showContextActions && (
                <>
                  {actions.map((action) => (
                    <MenuItem
                      key={action.id}
                      icon={action.icon}
                      label={action.label}
                      onClick={() => {
                        if (action.to) navigate(action.to);
                        else void action.run?.();
                        close();
                      }}
                    />
                  ))}
                  {imageProps && (
                    <MenuItem icon={<ImageIcon className="h-4 w-4" />} label={t("images.title")} onClick={() => { setImageOpen(true); close(); }} />
                  )}
                  {saveReg && (
                    <MenuItem icon={<Save className="h-4 w-4" />} label={t("ctx.save")} disabled={!saveReg.dirty} onClick={() => { void saveReg.save(); close(); }} />
                  )}
                  {menu.prose && <div className="my-1 h-px bg-border" />}
                </>
              )}
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
              {(menu.editable || menu.selection) && <MenuItem icon={<ClipboardPaste className="h-4 w-4" />} label={t("ctx.specialPaste")} onClick={() => setShowHistory(true)} />}
            </div>
          )}
        </div>
      )}

      {imageProps && (
        <AssetImageDialog
          {...imageProps}
          open={imageOpen}
          onOpenChange={setImageOpen}
          hideTrigger
        />
      )}
    </>
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
