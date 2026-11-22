import { BookOpen, BookOpenText, ClipboardCheck, Clapperboard, Download, Feather, Images, LayoutDashboard, ListTree, Plane, Search, ShieldAlert, SlidersHorizontal, Users, type LucideIcon } from "lucide-react";

/**
 * The Outline (the plan of the chapters, a page of the book): its entry is in the Book group, after the Dashboard. `outlineReady: false` leaves it
 * out, as the menu was before its page existed.
 */
export const OUTLINE_PAGE_READY = true;

export type BookMenuGroupId = "book" | "autopilot" | "profiles" | "tools";

export interface BookMenuItem {
  /** The key of its label in the always-loaded texts: the menu is drawn before any page loads its own. */
  labelKey: string;
  href: string;
  icon: LucideIcon;
  /** The pages under this address belong to the entry too (one research is a page of Research): its group opens on them. */
  ownsSubpages?: boolean;
}

export interface BookMenuGroup {
  id: BookMenuGroupId;
  titleKey: string;
  items: BookMenuItem[];
}

/**
 * The menu of a book, as the owner chose it: Book (overview, dashboard, outline, reader, export), Autopilot (live, configuration), Profiles
 * (director, ghostwriters, evaluation style, simulated readers) and Tools (audit, research, assets). The canon and the settings of the book
 * are drawn apart by the sidebar.
 */
export function bookMenuGroups(bookId: string, { outlineReady = OUTLINE_PAGE_READY }: { outlineReady?: boolean } = {}): BookMenuGroup[] {
  const root = `/app/books/${bookId}`;
  return [
    {
      id: "book",
      titleKey: "nav.groupBook",
      items: [
        { labelKey: "nav.bookOverview", href: root, icon: BookOpen },
        { labelKey: "dashboard.title", href: `${root}/dashboard`, icon: LayoutDashboard },
        ...(outlineReady ? [{ labelKey: "nav.outline", href: `${root}/outline`, icon: ListTree }] : []),
        { labelKey: "reader.title", href: `${root}/reader`, icon: BookOpenText },
        { labelKey: "export.title", href: `${root}/export`, icon: Download },
      ],
    },
    {
      id: "autopilot",
      titleKey: "autopilot.title",
      items: [
        { labelKey: "nav.autopilotLive", href: `${root}/autopilot`, icon: Plane },
        { labelKey: "nav.autopilotSettings", href: `${root}/autopilot/settings`, icon: SlidersHorizontal },
      ],
    },
    {
      id: "profiles",
      titleKey: "nav.groupProfiles",
      items: [
        { labelKey: "director.title", href: `${root}/director`, icon: Clapperboard },
        { labelKey: "ghostwriters.title", href: `${root}/ghostwriters`, icon: Feather },
        { labelKey: "evaluationStyle.title", href: `${root}/evaluation-style`, icon: ClipboardCheck },
        { labelKey: "readerPersonas.title", href: `${root}/simulated-readers`, icon: Users },
      ],
    },
    {
      id: "tools",
      titleKey: "nav.groupTools",
      items: [
        { labelKey: "audit.title", href: `${root}/audit`, icon: ShieldAlert },
        { labelKey: "research.title", href: `${root}/research`, icon: Search, ownsSubpages: true },
        { labelKey: "assets.title", href: `${root}/assets`, icon: Images },
      ],
    },
  ];
}

/** The group that holds the page at `pathname`: the one of the entry with that address, or of an entry that owns the pages under it. */
export function bookMenuGroupOf(groups: readonly BookMenuGroup[], pathname: string): BookMenuGroupId | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  for (const group of groups) {
    if (group.items.some((item) => item.href === path || (item.ownsSubpages && path.startsWith(`${item.href}/`)))) return group.id;
  }
  return null;
}
