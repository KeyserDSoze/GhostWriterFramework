import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Globe, Lock } from "lucide-react";
import "@/i18n/githubRepositoryPicker";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatPushed, type PickerRepository } from "@/github/repositoryPickerModel";

export interface RepositoryComboboxProps {
  /** The visible label of the field. */
  label: string;
  /** What the list shows now: the repositories that match the query. */
  items: readonly PickerRepository[];
  /** How many repositories are read so far (before the query). */
  loaded: number;
  /** `owner/name`, lower case, of the repositories that are books of this app already. */
  added?: ReadonlySet<string>;
  selectedId: number | null;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (repository: PickerRepository) => void;
  status: "idle" | "loading" | "ready" | "error";
  hasMore: boolean;
  loadingMore: boolean;
  onLoadMore: () => void;
  disabled?: boolean;
  /** The id of the description the field is described by (the hint under it). */
  describedBy?: string;
}

const MORE = "more";
const PAGE_KEY_STEP = 10;

/**
 * A combobox with a listbox (WAI-ARIA 1.2): the field filters as it is typed, the arrows move through the options without leaving the field, Enter chooses
 * one, Escape closes the list (and, closed, clears the field), Home and End go to the first and the last option while one is active. The result count is said
 * in a polite live region, a little after the typing stops. The list is part of the page, under the field, so that it never goes out of a small screen or a
 * zoomed one. Its last option reads the next page when the account has more.
 */
export function RepositoryCombobox(props: RepositoryComboboxProps) {
  const { label, items, loaded, added, selectedId, query, onQueryChange, onSelect, status, hasMore, loadingMore, onLoadMore, disabled, describedBy } = props;
  const { t, i18n } = useTranslation();
  const base = useId();
  const inputId = `${base}-input`;
  const listId = `${base}-list`;
  const optionId = (key: string | number) => `${base}-opt-${key}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const locale = i18n.resolvedLanguage || i18n.language;

  const rows = useMemo(() => [...items.map((repository) => ({ key: String(repository.id), repository })), ...(hasMore ? [{ key: MORE, repository: null }] : [])], [items, hasMore]);
  const expanded = open && rows.length > 0 && !disabled;
  const activeKey = expanded && active >= 0 && active < rows.length ? rows[active].key : null;

  useEffect(() => { setActive(-1); }, [query]);
  useEffect(() => { if (active >= rows.length) setActive(rows.length - 1); }, [rows.length, active]);
  useEffect(() => {
    if (activeKey) (document.getElementById(optionId(activeKey)) as (HTMLElement & { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }) | null)?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // The count is said a little after the typing stops, so that a screen reader does not read one number for each key.
  const count = status === "ready" ? items.length : null;
  const [said, setSaid] = useState("");
  useEffect(() => {
    const text = status === "loading" ? t("github.picker.list.loading")
      : status === "ready" ? `${t("github.picker.list.count", { count: items.length })}${hasMore ? ` ${t("github.picker.list.more")}` : ""}`
        : "";
    const timer = setTimeout(() => setSaid(text), status === "ready" && query ? 350 : 0);
    return () => clearTimeout(timer);
  }, [status, items.length, hasMore, query, t]);

  const choose = (row: (typeof rows)[number]) => {
    if (!row.repository) { onLoadMore(); return; }
    onSelect(row.repository);
    onQueryChange(row.repository.fullName);
    setOpen(false);
    setActive(-1);
  };

  const move = (next: number) => {
    if (!rows.length) return;
    setOpen(true);
    setActive(((next % rows.length) + rows.length) % rows.length);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        if (!expanded) { setOpen(true); if (!event.altKey) setActive(Math.max(0, rows.findIndex((row) => row.key === String(selectedId)))); }
        else move(active + 1);
        break;
      case "ArrowUp":
        event.preventDefault();
        if (!expanded) { setOpen(true); setActive(rows.length - 1); } else move(active <= 0 ? rows.length - 1 : active - 1);
        break;
      case "Home":
        if (expanded && active >= 0) { event.preventDefault(); setActive(0); }
        break;
      case "End":
        if (expanded && active >= 0) { event.preventDefault(); setActive(rows.length - 1); }
        break;
      case "PageDown":
        if (expanded) { event.preventDefault(); setActive(Math.min(rows.length - 1, Math.max(0, active) + PAGE_KEY_STEP)); }
        break;
      case "PageUp":
        if (expanded) { event.preventDefault(); setActive(Math.max(0, active - PAGE_KEY_STEP)); }
        break;
      case "Enter":
        if (expanded && active >= 0) { event.preventDefault(); choose(rows[active]); }
        break;
      case "Escape":
        if (expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1); }
        else if (query) { event.preventDefault(); onQueryChange(""); }
        break;
      default:
    }
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="relative">
        <input
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeKey ? optionId(activeKey) : undefined}
          aria-describedby={describedBy}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          value={query}
          placeholder={t("github.picker.list.placeholder")}
          className="flex h-10 w-full rounded-md border border-field bg-background py-2 pl-3 pr-10 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 [@media(pointer:coarse)]:h-11"
          onChange={(event) => { onQueryChange(event.target.value); setOpen(true); }}
          onFocus={() => { if (rows.length) setOpen(true); }}
          onBlur={() => { setOpen(false); setActive(-1); }}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={t(expanded ? "github.picker.list.hide" : "github.picker.list.show")}
          aria-expanded={expanded}
          aria-controls={listId}
          disabled={disabled}
          // The input keeps the focus: the list is opened and closed without moving it.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => { setOpen((value) => !value); document.getElementById(inputId)?.focus(); }}
          className="absolute right-0 top-0 inline-flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:text-foreground disabled:opacity-50 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
        >
          <ChevronDown aria-hidden="true" className={cn("h-4 w-4 transition-transform motion-reduce:transition-none", expanded && "rotate-180")} />
        </button>
      </div>
      <ul
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label={label}
        hidden={!expanded}
        className="max-h-72 overflow-y-auto rounded-md border border-layer bg-popover p-1 text-popover-foreground shadow-sm"
      >
        {expanded && rows.map((row, index) => {
          const repository = row.repository;
          const isActive = index === active;
          if (!repository) {
            return (
              <li
                key={MORE}
                id={optionId(MORE)}
                role="option"
                aria-selected={isActive}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(row)}
                className={cn("flex min-h-11 cursor-pointer items-center rounded-sm px-3 py-2 text-sm font-medium", isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60")}
              >
                {loadingMore ? t("github.picker.list.loadingMore") : t("github.picker.list.loadMore")}
              </li>
            );
          }
          const selected = repository.id === selectedId;
          const pushed = formatPushed(repository.pushedAt, locale);
          return (
            <li
              key={row.key}
              id={optionId(row.key)}
              role="option"
              aria-selected={isActive}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(row)}
              onMouseMove={() => { if (!isActive) setActive(index); }}
              className={cn("min-h-11 cursor-pointer rounded-sm px-3 py-2", isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60", selected && "font-semibold")}
            >
              <span className="block break-all text-sm font-medium">{repository.fullName}</span>
              <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  {repository.private ? <Lock aria-hidden="true" className="h-3 w-3" /> : <Globe aria-hidden="true" className="h-3 w-3" />}
                  {t(repository.private ? "github.picker.flag.private" : "github.picker.flag.public")}
                </span>
                {repository.canPush !== null && <span>{t(repository.canPush ? "github.picker.flag.canPush" : "github.picker.flag.readOnly")}</span>}
                {repository.archived && <span>{t("github.picker.flag.archived")}</span>}
                {pushed && <span>{t("github.picker.flag.pushed", { when: pushed })}</span>}
                {added?.has(repository.fullName.toLowerCase()) && <span className="font-medium">{t("github.picker.flag.added")}</span>}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="text-xs text-muted-foreground" aria-hidden="true">
        {status === "ready" ? `${t("github.picker.list.count", { count: items.length })}${count !== null && loaded > items.length ? ` · ${t("github.picker.list.ofLoaded", { loaded })}` : ""}` : ""}
      </p>
      <div role="status" aria-live="polite" className="sr-only">{said}</div>
    </div>
  );
}
