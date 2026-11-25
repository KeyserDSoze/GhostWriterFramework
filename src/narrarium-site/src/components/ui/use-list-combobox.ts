import { useEffect, useId, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";

const PAGE_KEY_STEP = 10;

export interface ListComboboxOptions<Row extends { key: string }> {
  /** What the list shows now (already filtered by the query). */
  rows: readonly Row[];
  /** The text of the field: a new query puts the active option back to none. */
  query: string;
  /** An option was chosen (Enter, a click). Return `false` to keep the list open (an option that loads more). */
  onChoose: (row: Row) => boolean | void;
  disabled?: boolean;
  /** The option ArrowDown lands on when it opens the list (the one chosen before). */
  selectedKey?: string | null;
  /** The list is always shown (a list in a dialog): Escape and leaving the field are left to the dialog. */
  alwaysOpen?: boolean;
  /** Escape on a closed list: the field clears its query, for one. */
  onEscapeClosed?: () => void;
}

/**
 * The keyboard and the ARIA of a combobox with a listbox (WAI-ARIA 1.2), shared by the pickers of the app: the field keeps the focus while the arrows move
 * through the options (`aria-activedescendant`), Enter chooses one, Escape closes the list, Home and End go to the first and the last option while one is
 * active, Page Up and Page Down move ten. The component draws the field, the list and its options with the props it gets here.
 */
export function useListCombobox<Row extends { key: string }>(options: ListComboboxOptions<Row>) {
  const { rows, query, onChoose, disabled, selectedKey, alwaysOpen, onEscapeClosed } = options;
  const base = useId();
  const listId = `${base}-list`;
  const optionId = (key: string) => `${base}-opt-${key}`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const expanded = (alwaysOpen || open) && rows.length > 0 && !disabled;
  const activeKey = expanded && active >= 0 && active < rows.length ? rows[active].key : null;

  useEffect(() => { setActive(-1); }, [query]);
  useEffect(() => { if (active >= rows.length) setActive(rows.length - 1); }, [rows.length, active]);
  useEffect(() => {
    if (activeKey) (document.getElementById(optionId(activeKey)) as (HTMLElement & { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }) | null)?.scrollIntoView?.({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  const choose = (row: Row) => {
    if (onChoose(row) === false) return;
    if (!alwaysOpen) setOpen(false);
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
        if (!expanded) { setOpen(true); if (!event.altKey) setActive(Math.max(0, rows.findIndex((row) => row.key === selectedKey))); }
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
        if (alwaysOpen) break;
        if (expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1); }
        else if (onEscapeClosed) { event.preventDefault(); onEscapeClosed(); }
        break;
      default:
    }
  };

  return {
    listId,
    optionId,
    expanded,
    active,
    setActive,
    setOpen,
    choose,
    inputProps: {
      role: "combobox" as const,
      "aria-expanded": expanded,
      "aria-controls": listId,
      "aria-autocomplete": "list" as const,
      "aria-activedescendant": activeKey ? optionId(activeKey) : undefined,
      autoComplete: "off",
      spellCheck: false,
      onKeyDown,
      onFocus: () => { if (rows.length) setOpen(true); },
      onBlur: (_event: FocusEvent<HTMLInputElement>) => { if (!alwaysOpen) { setOpen(false); setActive(-1); } },
    },
    optionProps: (index: number) => ({
      id: optionId(rows[index].key),
      role: "option" as const,
      "aria-selected": index === active,
      // The field keeps the focus: a click chooses without moving it.
      onMouseDown: (event: MouseEvent) => event.preventDefault(),
      onClick: () => choose(rows[index]),
      onMouseMove: () => { if (index !== active) setActive(index); },
    }),
  };
}
