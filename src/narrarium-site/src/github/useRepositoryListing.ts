import { useCallback, useEffect, useRef, useState } from "react";
import { ListingError, fetchListingPage, type ListingCursor, type ListingSource } from "@/github/repositoryListing";
import type { PickerRepository } from "@/github/repositoryPickerModel";

export interface RepositoryListing {
  /** `idle` while there is nothing to read (no credential, or the installations are not known yet). */
  status: "idle" | "loading" | "ready" | "error";
  items: PickerRepository[];
  hasMore: boolean;
  loadingMore: boolean;
  /** Why the last read failed, when it did (the items already read stay). */
  error: ListingError | null;
  loadMore: () => void;
  /** Forget what was read and read the first page again (the person changed something on GitHub). */
  reload: () => void;
}

interface CacheEntry { items: PickerRepository[]; cursor: ListingCursor | null; at: number }

/** What was read stays for five minutes, for the credential and the owner it was read for: coming back to the list, or switching the mode, does not ask GitHub again. */
export const LISTING_CACHE_MS = 5 * 60_000;
const cache = new Map<string, CacheEntry>();

export function clearRepositoryListingCache(): void {
  cache.clear();
}

const asError = (error: unknown): ListingError => (error instanceof ListingError ? error : new ListingError("unknown"));
const aborted = (error: unknown): boolean => (error as { name?: string })?.name === "AbortError";

/**
 * The repositories of a credential, a page at a time: the first page when `sources` is known, the next ones when asked (`loadMore`). A new credential, owner
 * or set of sources aborts what was on its way; a failed page is never retried by itself (the rate limit, with its time, is for the person to read).
 */
export function useRepositoryListing(input: { token: string | undefined; cacheKey: string; sources: readonly ListingSource[] | null }): RepositoryListing {
  const { token, cacheKey, sources } = input;
  const key = token && sources ? `${cacheKey}|${sources.map((source) => source.path).join(",")}` : null;
  const [state, setState] = useState<Omit<RepositoryListing, "loadMore" | "reload">>({ status: "idle", items: [], hasMore: false, loadingMore: false, error: null });
  const [tick, setTick] = useState(0);
  const controller = useRef<AbortController | null>(null);
  const live = useRef({ key, token, sources, cursor: null as ListingCursor | null, items: [] as PickerRepository[], busy: false });
  live.current.key = key;
  live.current.token = token;
  live.current.sources = sources;

  useEffect(() => {
    controller.current?.abort();
    live.current.busy = false;
    if (!key || !token || !sources) { live.current.items = []; live.current.cursor = null; setState({ status: "idle", items: [], hasMore: false, loadingMore: false, error: null }); return; }
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < LISTING_CACHE_MS) {
      live.current.items = cached.items;
      live.current.cursor = cached.cursor;
      setState({ status: "ready", items: cached.items, hasMore: cached.cursor !== null, loadingMore: false, error: null });
      return;
    }
    cache.delete(key);
    const own = new AbortController();
    controller.current = own;
    live.current.items = [];
    live.current.cursor = null;
    live.current.busy = true;
    setState({ status: "loading", items: [], hasMore: false, loadingMore: false, error: null });
    void fetchListingPage(token, sources, null, { signal: own.signal }).then(
      (page) => {
        if (own.signal.aborted) return;
        live.current.busy = false;
        live.current.items = page.items;
        live.current.cursor = page.cursor;
        cache.set(key, { items: page.items, cursor: page.cursor, at: Date.now() });
        setState({ status: "ready", items: page.items, hasMore: page.cursor !== null, loadingMore: false, error: null });
      },
      (error: unknown) => {
        if (own.signal.aborted || aborted(error)) return;
        live.current.busy = false;
        setState({ status: "error", items: [], hasMore: false, loadingMore: false, error: asError(error) });
      },
    );
    return () => own.abort();
    // `sources` is covered by `key`: a new array with the same paths is the same list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, tick]);

  const loadMore = useCallback(() => {
    const current = live.current;
    if (!current.key || !current.token || !current.sources || !current.cursor || current.busy) return;
    const own = new AbortController();
    controller.current = own;
    current.busy = true;
    const { key: forKey, token: forToken, sources: forSources, cursor } = current;
    setState((before) => ({ ...before, loadingMore: true, error: null }));
    void fetchListingPage(forToken, forSources, cursor, { signal: own.signal }).then(
      (page) => {
        if (own.signal.aborted || live.current.key !== forKey) return;
        current.busy = false;
        const items = [...current.items, ...page.items.filter((item) => !current.items.some((known) => known.id === item.id))];
        current.items = items;
        current.cursor = page.cursor;
        cache.set(forKey, { items, cursor: page.cursor, at: Date.now() });
        setState({ status: "ready", items, hasMore: page.cursor !== null, loadingMore: false, error: null });
      },
      (error: unknown) => {
        if (own.signal.aborted || aborted(error) || live.current.key !== forKey) return;
        current.busy = false;
        setState((before) => ({ ...before, loadingMore: false, error: asError(error) }));
      },
    );
  }, []);

  const reload = useCallback(() => {
    if (live.current.key) cache.delete(live.current.key);
    setTick((value) => value + 1);
  }, []);

  useEffect(() => () => controller.current?.abort(), []);

  return { ...state, loadMore, reload };
}
