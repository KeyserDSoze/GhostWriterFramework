import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Plane, Search, Server } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { BookCard } from "@/components/autopilot/hub/BookCard";
import { LiveAnnouncer } from "@/components/autopilot/live/LiveControls";
import { HubFeed } from "@/components/autopilot/hub/HubFeed";
import { HUB_FILTER_FROM, filterBooks, hubRank, hubStateOf, orderBooks, type HubRank } from "@/autopilot/hubModel";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { useAutopilotStore } from "@/autopilot/store";
import { useServerConnection } from "@/autopilot/serverConnection";
import { useContainerWidth } from "@/hooks/useContainerWidth";
import { useSettingsStore } from "@/store/settingsStore";

/** The books read at the same time when the page opens: the cards fill in quickly, and a library of 50 books does not ask for 50 reads at once. */
const READS_AT_ONCE = 4;

type StoreState = ReturnType<typeof useAutopilotStore.getState>;

/** Where a book's card goes, from what the store holds of it, without summarizing its state (see `hubStateOf`). */
function rankIn(store: StoreState, bookId: string): HubRank {
  const view = store.views[bookId];
  const state = view?.snapshot?.state ?? null;
  const live = store.summaries[bookId];
  const downloaded = view?.snapshot?.summary ?? null;
  const fresh = state && live && live.updatedAt >= state.updatedAt ? live : downloaded;
  return hubRank(hubStateOf(state, live, downloaded), fresh?.frozenChanges ?? 0);
}

/**
 * Every book's autopilot at a glance, one card for each book, and what happens in all of them. The books that ask the author something come
 * first, then the ones that run, then the others. The page reads each book's autopilot as it always did (the runtime's download of its saved
 * state and log, in this browser or from the personal server), a few books at a time; a book that cannot be read says so on its own card.
 */
export function AutopilotHubPage() {
  const { t } = useTranslation();
  const books = useSettingsStore((state) => state.settings.books);
  const server = useServerConnection();
  const bookIds = useMemo(() => books.map((book) => book.id).join(","), [books]);
  const filterId = useId();
  const [query, setQuery] = useState("");
  // Two columns of cards when their column has room for two (the sidebar and the feed take their part of the screen).
  const [cardsColumn, setCardsColumn] = useState<HTMLElement | null>(null);
  const { width } = useContainerWidth(cardsColumn);
  const twoColumns = width !== null && width >= 760;

  useEffect(() => {
    let cancelled = false;
    void loadAutopilotRuntime().then(async (runtime) => {
      runtime.ensureServerStream();
      const queue = bookIds.split(",").filter(Boolean);
      const reader = async () => {
        while (!cancelled && queue.length) {
          const id = queue.shift()!;
          await runtime.refresh(id, { join: true }).catch(() => undefined);
        }
      };
      await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, queue.length) }, reader));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [bookIds]);

  // One character for each book (its rank): the page is drawn again only when a book changes place, not for every event of every book.
  const ranks = useAutopilotStore(useCallback((store: StoreState) => books.map((book) => rankIn(store, book.id)).join(""), [books]));
  const ordered = useMemo(() => {
    const rankOf = new Map(books.map((book, index) => [book.id, Number(ranks[index] ?? 2) as HubRank]));
    return orderBooks(books, (id) => rankOf.get(id) ?? 2);
  }, [books, ranks]);
  const filtering = books.length >= HUB_FILTER_FROM;
  // One polite voice for the page, which names the book of what it says: a step answering, a step done or failed.
  const allIds = useMemo(() => books.map((book) => book.id), [books]);
  const nameOf = useCallback((id: string) => books.find((book) => book.id === id)?.name, [books]);
  const shown = filtering && query.trim() ? filterBooks(ordered, query) : ordered;

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight"><Plane className="h-6 w-6 text-primary" aria-hidden="true" />{t("autopilot.title")}</h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">{t("autopilot.hubDescription")}</p>
        </div>
        <Link to="/app/settings/server" className="flex min-h-11 items-center gap-2 rounded-xl border border-layer bg-card px-3 py-2 text-sm shadow-sm transition hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <Server className="h-4 w-4 text-primary" aria-hidden="true" />
          <span>{t("autopilot.hub.server")}</span>
          <Badge variant="outline">{t(`personalServer.status.${server.status}`)}</Badge>
          {server.status === "online" && server.updates?.available && server.updates.latestVersion && (
            <Badge className="border-transparent bg-amber-500/15 text-amber-800 dark:text-amber-300">{t("autopilot.hub.serverUpdate", { version: server.updates.latestVersion })}</Badge>
          )}
        </Link>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,22rem)]">
        <section ref={setCardsColumn} aria-labelledby={`${filterId}-books`} className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id={`${filterId}-books`} className="text-lg font-semibold">{t("autopilot.hub.books")}</h2>
            {filtering && (
              <div className="w-full max-w-xs space-y-1">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                  <Input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    aria-label={t("autopilot.hub.filter")}
                    placeholder={t("autopilot.hub.filter")}
                    aria-describedby={query.trim() ? `${filterId}-count` : undefined}
                    className="h-11 pl-8 sm:h-9"
                  />
                </div>
                {query.trim() && <p id={`${filterId}-count`} className="text-xs text-muted-foreground">{t("autopilot.hub.filterCount", { shown: shown.length, count: books.length })}</p>}
              </div>
            )}
          </div>
          {books.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("autopilot.hub.noBooks")}</p>
          ) : shown.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("autopilot.hub.filterNone")}</p>
          ) : (
            <ul className={twoColumns ? "grid grid-cols-2 gap-3" : "grid gap-3"}>
              {shown.map((book) => <li key={book.id} className="min-w-0"><BookCard book={book} /></li>)}
            </ul>
          )}
        </section>
        <HubFeed className="self-start" />
      </div>
      <LiveAnnouncer bookIds={allIds} nameOf={nameOf} />
    </div>
  );
}
