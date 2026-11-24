import { useRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The parts of the configuration a link can point at: the hash of a card, or of a panel, and the tab that holds it. */
const HASH_TABS: Record<string, string> = {
  "autopilot-estimate": "overview",
  "autopilot-rules": "rules",
  "autopilot-profiles": "profiles",
  "autopilot-danger": "danger",
  "autopilot-calls": "calls",
};

/** The tab a link to `#autopilot-…` selects, or `undefined` for a hash that is no part of the configuration. */
export function tabOfHash(hash: string): string | undefined {
  const id = decodeURIComponent(hash.replace(/^#/, ""));
  return HASH_TABS[id] ?? /^autopilot-(overview|review|retries|publishing|rules|profiles|danger)$/.exec(id)?.[1];
}

export interface ConfigTab {
  key: string;
  label: string;
  panel: ReactNode;
}

/**
 * The parts of the configuration as a WAI-ARIA tablist: one tab is selected, the arrow keys, Home and End move between the tabs (and select them), and
 * only the selected tab is in the tab order. Each panel is labelled by its tab and keeps its state while another tab is shown (it is hidden, not
 * drawn again), so that a rule being edited or a field being typed is not lost. The panel of a tab has the id `<idPrefix>-panel-<key>` (`autopilot` for the autopilot's configuration, the book's settings use their own); a link to a part of the configuration (`tabOfHash`) selects the tab that holds it. The
 * list scrolls sideways on a narrow screen.
 */
export function ConfigTabs({ label, tabs, selected, onSelect, idPrefix = "autopilot" }: { label: string; tabs: ConfigTab[]; selected: string; onSelect: (key: string) => void; idPrefix?: string }) {
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const index = Math.max(0, tabs.findIndex((tab) => tab.key === selected));

  const move = (to: number) => {
    const next = tabs[(to + tabs.length) % tabs.length];
    onSelect(next.key);
    buttons.current.get(next.key)?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, () => void> = {
      ArrowRight: () => move(index + 1),
      ArrowLeft: () => move(index - 1),
      Home: () => move(0),
      End: () => move(tabs.length - 1),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  };

  return (
    <div className="space-y-4">
      <div role="tablist" aria-label={label} className="-mx-1 flex gap-1 overflow-x-auto border-b px-1">
        {tabs.map((tab, position) => {
          const active = position === index;
          return (
            <button
              key={tab.key}
              ref={(element) => {
                if (element) buttons.current.set(tab.key, element);
                else buttons.current.delete(tab.key);
              }}
              id={`${idPrefix}-tab-${tab.key}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`${idPrefix}-panel-${tab.key}`}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(tab.key)}
              onKeyDown={onKeyDown}
              className={cn(
                "-mb-px min-h-11 shrink-0 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.key}
          id={`${idPrefix}-panel-${tab.key}`}
          role="tabpanel"
          aria-labelledby={`${idPrefix}-tab-${tab.key}`}
          tabIndex={0}
          hidden={tab.key !== selected}
          className="space-y-5 rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_input]:scroll-mt-32 [&_textarea]:scroll-mt-32"
        >
          {tab.panel}
        </div>
      ))}
    </div>
  );
}
