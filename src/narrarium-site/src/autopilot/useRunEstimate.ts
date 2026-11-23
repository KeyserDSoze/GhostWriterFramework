import { useEffect, useMemo, useRef, useState } from "react";
import { pickAiRuntimeConfig, type AutopilotActivity, type AutopilotState, type ServerAiStatus } from "narrarium-engine";
import { createBrowserBookStore } from "@/autopilot/browserStore";
import { configFromServerStatus, type EstimateSources } from "@/autopilot/runEstimate";
import { readEstimateBook, type EstimateBook } from "@/autopilot/runEstimateBook";
import { useServerConnection } from "@/autopilot/serverConnection";
import { verifiedServer } from "@/autopilot/serverIdentity";
import { browserOutlineSource } from "@/outline/outlineSource";
import { useSettingsStore } from "@/store/settingsStore";
import type { BookStructure } from "@/types/book";
import type { BookEntry } from "@/types/settings";

const NO_ACTIVITIES: readonly AutopilotActivity[] = [];
const UNREAD: EstimateBook = { read: false, directorFile: false, context: {}, designWritten: false };

/**
 * What the files of the book say for the estimate: read once, when the page opens or the book changes, and never while the author types (nothing in the form is in a file). Until
 * they are read, and for a book whose working copy this browser does not have, the estimate is made with the engine's typical sizes, and says so.
 */
export function useEstimateBook(book: BookEntry, branch: string, structure: BookStructure | undefined): { book: EstimateBook; reading: boolean } {
  // The settings are replaced whenever they reload, so the `book` object is new each time: the files are read again only for another book or branch.
  const latest = useRef(book);
  latest.current = book;
  const ghostwriterSlugs = useMemo(() => (structure?.ghostwriters ?? []).map((entry) => entry.slug), [structure?.ghostwriters]);
  const personaPaths = useMemo(() => (structure?.readerPersonas ?? []).map((entry) => entry.path), [structure?.readerPersonas]);
  const language = structure?.language;
  const ghostwriter = structure?.ghostwriter;
  const key = [book.id, book.owner, book.repo, branch, structure?.loadedBranch ?? "", language ?? "", ghostwriter ?? "", ghostwriterSlugs.join(","), personaPaths.join(",")].join("\n");
  const [read, setRead] = useState<{ book: EstimateBook; reading: boolean }>({ book: UNREAD, reading: true });
  useEffect(() => {
    let cancelled = false;
    setRead((current) => (current.reading ? current : { ...current, reading: true }));
    const target = latest.current;
    void readEstimateBook({ store: createBrowserBookStore(target, branch), outlineFiles: () => browserOutlineSource(target, branch).files(), language, ghostwriter, ghostwriterSlugs, personaPaths })
      .then((result) => { if (!cancelled) setRead({ book: result, reading: false }); })
      .catch(() => { if (!cancelled) setRead({ book: UNREAD, reading: false }); });
    return () => { cancelled = true; };
    // `key` stands for every value it is made of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return read;
}

/** What the personal server said of its AI configuration: it is being asked, it answered, or it could not be asked (offline, not verified, an error). */
export type ServerAiRead = { status: "idle" } | { status: "loading" } | { status: "ready"; value: ServerAiStatus } | { status: "unavailable" };

/**
 * The AI configuration of the personal server (`GET /api/v1/ai`: the same safe view the settings of the server show, with no key and no price), asked once the server is online
 * and its identity is verified. Not asked at all for a book that runs in this browser.
 */
export function useServerAiStatus(enabled: boolean): ServerAiRead {
  const server = useServerConnection();
  const connection = server.status === "online" ? server.connection : null;
  const pending = server.status === "connecting" || server.status === "reconnecting";
  const [read, setRead] = useState<ServerAiRead>({ status: "idle" });
  useEffect(() => {
    if (!enabled) {
      setRead({ status: "idle" });
      return undefined;
    }
    if (!connection) {
      setRead({ status: pending ? "loading" : "unavailable" });
      return undefined;
    }
    const controller = new AbortController();
    setRead({ status: "loading" });
    verifiedServer({ connection, signal: controller.signal })
      .then(({ client }) => client.aiStatus())
      .then((value) => { if (!controller.signal.aborted) setRead({ status: "ready", value }); })
      .catch(() => { if (!controller.signal.aborted) setRead({ status: "unavailable" }); });
    return () => controller.abort();
  }, [enabled, connection, pending]);
  return read;
}

export interface RunEstimateInputs {
  /** Everything the estimate reads besides the form. It changes only when something it is made of changes, never while the author types. */
  sources: EstimateSources;
  /** The files of the book are being read: the figures are the typical ones until then. */
  reading: boolean;
  /** For a book that runs on the personal server: what its AI configuration said. */
  server: ServerAiRead;
  host: "browser" | "server";
}

interface RunEstimateArguments {
  book: BookEntry;
  branch: string;
  structure: BookStructure | undefined;
  state: AutopilotState | null;
  activities: readonly AutopilotActivity[] | undefined;
}

/**
 * Where the estimate of a run gets what it needs. The models are the ones that make the calls: this browser's AI configuration for a book that runs here, and the personal server's
 * for a book that runs there (its configuration can differ from the browser's, and the server is who calls); a server that cannot be asked leaves this browser's in its place, and the
 * page says so. The speed and the tokens a word come from the log of what the book already ran, the director, the story design, the outline and the profiles from its files, and where the
 * book is from its state, or from its chapters for one the autopilot never planned.
 */
export function useRunEstimateSources({ book, branch, structure, state, activities }: RunEstimateArguments): RunEstimateInputs {
  const settings = useSettingsStore((store) => store.settings);
  const host = book.autopilotHost === "server" ? "server" : "browser";
  const browserConfig = useMemo(() => pickAiRuntimeConfig(settings), [settings]);
  const server = useServerAiStatus(host === "server");
  const files = useEstimateBook(book, branch, structure);
  const chapters = useMemo(() => (structure ? (structure.chapters ?? []).map((chapter) => ({ paragraphs: chapter.paragraphs, summary: chapter.hasResume ? "summary" : undefined })) : null), [structure]);
  const canonEntries = [structure?.characters, structure?.locations, structure?.factions, structure?.items, structure?.timelines].reduce((total, list) => total + (list?.length ?? 0), 0);
  const serverConfig = useMemo(() => (server.status === "ready" ? configFromServerStatus(server.value, browserConfig) : null), [server, browserConfig]);
  const sources = useMemo<EstimateSources>(() => ({
    book: files.book,
    language: structure?.language,
    currency: settings.costCurrency || undefined,
    ai: host === "server" && serverConfig ? serverConfig : browserConfig,
    aiFrom: host === "browser" ? "browser" : serverConfig ? "server" : "browser-for-server",
    activities: activities ?? NO_ACTIVITIES,
    state,
    chapters,
    canonEntries,
  }), [files.book, structure?.language, settings.costCurrency, host, serverConfig, browserConfig, activities, state, chapters, canonEntries]);
  return { sources, reading: files.reading, server, host };
}
