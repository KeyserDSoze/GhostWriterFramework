import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useLocation } from "react-router-dom";
import { BookOpen, ClipboardPaste, Copy, Image as ImageIcon, RefreshCcw, Save, Scissors, Search, Sparkles, TextCursorInput, Users, Wand2 } from "lucide-react";
import { useClipboardStore } from "@/clipboard/clipboardStore";
import { useProseEditorStore, type ProseEditorActions } from "@/components/editor/proseEditorStore";
import { useContextualActions } from "@/hooks/useContextualActions";
import { useSaveStore } from "@/store/saveStore";
import { triggerCurrentRepositorySync, useRepositorySyncStore } from "@/store/repositorySyncStore";
import { AssetImageDialog } from "@/components/book/AssetImageDialog";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { parseAppRoute } from "@/assistant/context";
import { resolveBookToken } from "@/types/settings";
import { slugToTitle } from "@/github/githubClient";
import { openCanonDossier } from "@/narrarium/openDossier";
import { CANON_SECTION_ORDER, type CanonSection } from "@/lib/canonSections";
import type { BookStructure } from "@/types/book";
import { useToast } from "@/components/ui/use-toast";
import { CustomActionRunner, type CustomActionInvocation } from "@/components/custom-actions/CustomActionRunner";
import { compatibleCustomActions, resolveCustomActionTarget } from "@/custom-actions/customActions";
import type { CustomAction } from "@/types/settings";

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

function isTouchDevice(): boolean {
  return typeof window !== "undefined" && (window.matchMedia("(pointer: coarse)").matches || "ontouchstart" in window);
}

export function GlobalContextMenu() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { items, push } = useClipboardStore();
  const forElement = useProseEditorStore((s) => s.forElement);
  const { actions, hasBookActions, imageProps } = useContextualActions();
  const saveReg = useSaveStore((s) => s.current);
  const syncReg = useRepositorySyncStore((s) => s.current);
  const [menu, setMenu] = useState<MenuState>(CLOSED);
  const [showHistory, setShowHistory] = useState(false);
  const [customSubmenuOpen, setCustomSubmenuOpen] = useState(false);
  const [customInvocation, setCustomInvocation] = useState<CustomActionInvocation | null>(null);
  const [fab, setFab] = useState<{ x: number; y: number; editable: Editable | null } | null>(null);
  const [imageOpen, setImageOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const openAtRef = useRef<(x: number, y: number, target: EventTarget | null) => boolean>(() => false);

  // Book context for the "Open dossier" action.
  const { toast } = useToast();
  const location = useLocation();
  const { structures, workingBranches } = useBooksStore();
  const { settings } = useSettingsStore();
  const dossierRoute = parseAppRoute(location.pathname);
  const dossierBookId = "bookId" in dossierRoute ? dossierRoute.bookId : undefined;
  const readerEvaluationPath = dossierBookId && "chapterId" in dossierRoute
    ? "paragraphNum" in dossierRoute
      ? `/app/books/${dossierBookId}/chapters/${dossierRoute.chapterId}/paragraphs/${dossierRoute.paragraphNum}/reader-evaluations`
      : `/app/books/${dossierBookId}/chapters/${dossierRoute.chapterId}/reader-evaluations`
    : null;
  const dossierStructure = dossierBookId ? structures[dossierBookId] : undefined;
  const { branch: dossierBranch } = useWorkingBranch(dossierBookId);
  const customTarget = resolveCustomActionTarget({ pathname: location.pathname, settings, books: settings.books, structures, workingBranches });
  const currentCustomActions = compatibleCustomActions({
    actions: settings.customActions ?? [],
    targetType: customTarget?.type ?? null,
    selection: menu.selection,
    canReplace: Boolean(menu.editable),
  });
  const hasBaseContextActions = actions.length > 0 || hasBookActions || Boolean(saveReg) || Boolean(syncReg);
  const showBaseContextActions = hasBaseContextActions && !menu.selection.trim();
  const showCustomActions = currentCustomActions.length > 0;
  const showContextActions = showBaseContextActions || showCustomActions;

  // The word to look up: the selection, or the word under the caret in an editable.
  const dossierWord = (() => {
    const sel = menu.selection.trim();
    if (sel) return sel;
    const el = menu.editable;
    if (el) {
      const value = el.value;
      const pos = el.selectionStart ?? 0;
      const left = value.slice(0, pos).match(/[\p{L}\p{M}'’-]+$/u)?.[0] ?? "";
      const right = value.slice(pos).match(/^[\p{L}\p{M}'’-]+/u)?.[0] ?? "";
      return (left + right).trim();
    }
    return "";
  })();

  const dossierMatch = (() => {
    const word = dossierWord.toLowerCase().replace(/[^\p{L}\p{M}\s'’-]/gu, "").trim();
    if (word.length < 3 || !dossierStructure) return null;
    return findClosestEntity(word, dossierStructure);
  })();

  async function openDossierForWord() {
    if (!dossierMatch || !dossierBookId) return;
    const book = settings.books.find((b) => b.id === dossierBookId);
    const token = book ? resolveBookToken(book, settings) : "";
    if (!book || !token) return;
    close();
    try {
      await openCanonDossier({ token, owner: book.owner, repo: book.repo, branch: dossierBranch, bookId: dossierBookId, section: dossierMatch.section, file: { path: dossierMatch.path, name: dossierMatch.name, imagePath: dossierMatch.imagePath } });
    } catch (err) {
      toast({ title: t("dossier.openFailed"), description: String(err), variant: "destructive" });
    }
  }


  const selectionString = (editable: Editable | null) => {
    if (editable) return editable.value.slice(editable.selectionStart ?? 0, editable.selectionEnd ?? 0);
    return window.getSelection()?.toString() ?? "";
  };

  const openAt = (x: number, y: number, target: EventTarget | null) => {
    const editable = isEditable(target) ? target : null;
    const sel = selectionString(editable);
    const customForOpen = compatibleCustomActions({
      actions: settings.customActions ?? [],
      targetType: customTarget?.type ?? null,
      selection: sel,
      canReplace: Boolean(editable),
    });
    // Open when there is something actionable: an editable, a selection, or contextual actions.
    // (hasContextActions is read fresh here because openAtRef always points at the latest closure.)
    if (!editable && !sel.trim() && !hasBaseContextActions && customForOpen.length === 0) return false;
    const pad = 8;
    const width = 234;
    const left = Math.min(x, window.innerWidth - width - pad);
    const top = Math.min(y, window.innerHeight - 320 - pad);
    setMenu({ open: true, x: Math.max(pad, left), y: Math.max(pad, top), editable, prose: editable ? forElement(editable) : undefined, selection: sel });
    setShowHistory(false);
    setCustomSubmenuOpen(false);
    setFab(null);
    return true;
  };
  openAtRef.current = openAt;

  // ── Desktop: right-click ───────────────────────────────────────────────────
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.("[data-no-context-menu]")) return;
      const opened = openAtRef.current(e.clientX, e.clientY, e.target);
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

  const close = () => {
    setCustomSubmenuOpen(false);
    setMenu(CLOSED);
  };

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
  const selectedResearchText = menu.selection.trim();

  const openFromFab = () => {
    if (!fab) return;
    const target: EventTarget = fab.editable ?? document.body;
    fab.editable?.focus?.();
    openAt(Math.min(fab.x, window.innerWidth - 244), fab.y + 36, target);
  };

  function startCustomAction(action: CustomAction) {
    const editable = menu.editable;
    const range = editable && (editable.selectionEnd ?? 0) > (editable.selectionStart ?? 0)
      ? { start: editable.selectionStart ?? 0, end: editable.selectionEnd ?? 0 }
      : null;
    setCustomInvocation({ id: crypto.randomUUID(), action, selection: menu.selection, editable, range });
    setMenu(CLOSED);
    setCustomSubmenuOpen(false);
  }

  const customActionsBlock = showCustomActions ? (
    isTouchDevice() ? (
      <>
        <div className="my-1 h-px bg-border" />
        <div className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{t("customActions.title")}</div>
        {currentCustomActions.map((action) => (
          <MenuItem key={action.id} icon={<Wand2 className="h-4 w-4" />} label={action.name} onClick={() => startCustomAction(action)} />
        ))}
      </>
    ) : (
      <div className="relative" onMouseEnter={() => setCustomSubmenuOpen(true)}>
        <MenuItem icon={<Wand2 className="h-4 w-4" />} label={t("customActions.menu")} trailing="▶" onClick={() => setCustomSubmenuOpen((open) => !open)} />
        {customSubmenuOpen && (
          <div
            data-no-context-menu
            className={`absolute top-0 z-[75] w-[234px] overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-2xl ${menu.x + 480 > window.innerWidth ? "right-full mr-1" : "left-full ml-1"}`}
          >
            {currentCustomActions.map((action) => (
              <MenuItem key={action.id} icon={<Wand2 className="h-4 w-4" />} label={action.name} onClick={() => startCustomAction(action)} />
            ))}
          </div>
        )}
      </div>
    )
  ) : null;

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
                  {showBaseContextActions && (
                    <>
                      {actions.map((action) => (
                        <MenuItem
                          key={action.id}
                          icon={action.icon}
                          label={action.label}
                          shortcut={action.shortcut}
                          disabled={action.disabled}
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
                        <MenuItem icon={<Save className="h-4 w-4" />} label={t("ctx.save")} shortcut="Ctrl+S" disabled={!saveReg.dirty} onClick={() => { void saveReg.save(); close(); }} />
                      )}
                      {syncReg && (
                        <MenuItem icon={<RefreshCcw className={syncReg.busy ? "h-4 w-4 animate-spin" : "h-4 w-4"} />} label={t("repoStatus.sync")} shortcut="Ctrl+E" disabled={syncReg.busy} onClick={() => { void triggerCurrentRepositorySync(); close(); }} />
                      )}
                    </>
                  )}
                  {customActionsBlock}
                  {menu.prose && <div className="my-1 h-px bg-border" />}
                </>
              )}
              {dossierMatch && (
                <>
                  <MenuItem icon={<BookOpen className="h-4 w-4" />} label={t("dossier.openFor", { name: dossierMatch.name })} onClick={() => void openDossierForWord()} />
                  <div className="my-1 h-px bg-border" />
                </>
              )}
              {selectedResearchText && dossierBookId && (
                <>
                  <MenuItem
                    icon={<Search className="h-4 w-4" />}
                    label={t("research.contextMenuResearchSelection")}
                    onClick={() => {
                      navigate(`/app/books/${dossierBookId}/research`, { state: { newResearchQuery: selectedResearchText } });
                      close();
                    }}
                  />
                  <MenuItem
                    icon={<BookOpen className="h-4 w-4" />}
                    label={t("research.contextMenuSearchSaved")}
                    onClick={() => {
                      navigate(`/app/books/${dossierBookId}/research`, { state: { researchFilter: selectedResearchText } });
                      close();
                    }}
                  />
                  <div className="my-1 h-px bg-border" />
                </>
              )}
              {menu.selection.trim() && readerEvaluationPath && (
                <>
                  <MenuItem icon={<Users className="h-4 w-4" />} label={t("readerEvaluations.evaluateSelection")} onClick={() => { navigate(readerEvaluationPath, { state: { readerEvaluationSelection: menu.selection } }); close(); }} />
                  <div className="my-1 h-px bg-border" />
                </>
              )}
              {menu.prose && (
                <>
                  <MenuItem icon={<Wand2 className="h-4 w-4" />} label={menu.selection ? t("ctx.improveSelection") : t("ctx.improveAll")} onClick={() => { menu.prose!.improve(menu.selection || null); close(); }} />
                  {menu.prose.summarize && <MenuItem icon={<Sparkles className="h-4 w-4" />} label={menu.selection ? t("ctx.summarySelection") : t("ctx.summaryAll")} onClick={() => { menu.prose!.summarize?.(menu.selection || null); close(); }} />}
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

      <CustomActionRunner invocation={customInvocation} onDone={() => setCustomInvocation(null)} />
    </>
  );
}

function MenuItem({ icon, label, shortcut, trailing, onClick, disabled }: { icon: React.ReactNode; label: string; shortcut?: string; trailing?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40"
    >
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {shortcut && <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">({shortcut})</span>}
      {trailing && <span className="ml-auto shrink-0 text-xs text-muted-foreground">{trailing}</span>}
    </button>
  );
}

interface EntityMatch { section: CanonSection; name: string; path: string; imagePath?: string }

/** Find the canon entity whose name best matches a word (exact > startsWith > includes). */
function findClosestEntity(word: string, structure: BookStructure): EntityMatch | null {
  let best: EntityMatch | null = null;
  let bestScore = 0;
  for (const section of CANON_SECTION_ORDER) {
    const files = (structure as unknown as Record<string, BookStructure["characters"]>)[section] ?? [];
    for (const f of files) {
      const slug = (f.path.split("/").pop() ?? "").replace(/\.md$/i, "");
      const name = (f.name ?? slugToTitle(slug)).toLowerCase();
      let score = 0;
      if (name === word) score = 100;
      else if (name.startsWith(word) || word.startsWith(name)) score = 70;
      else if (name.includes(word) || word.includes(name)) score = 40;
      // Prefer longer overlaps to avoid matching very short names.
      if (score > 0) score += Math.min(name.length, word.length);
      if (score > bestScore) {
        bestScore = score;
        best = { section, name: f.name ?? slugToTitle(slug), path: f.path, imagePath: f.imagePath };
      }
    }
  }
  return best;
}
