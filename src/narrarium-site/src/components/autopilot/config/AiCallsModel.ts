import { bookStorageMode, resolveGitHubRemoteToken, type AppSettings, type BookEntry } from "@/types/settings";
import type { LocalSyncConfiguration } from "@/account/types";
import type { CopyStatus, CopyTargetKind } from "@/autopilot/calls/copies/types";

export type CopyChoice = "none" | CopyTargetKind;

export const COPY_CHOICES: readonly CopyChoice[] = ["none", "github", "google-drive", "onedrive"];

/** Why a place cannot be chosen: nothing is connected, the book has no repository, or it has no GitHub token. */
export type Unavailable = "noConnection" | "noRepository" | "noToken";

export interface ChoiceState {
  choice: CopyChoice;
  /** The radio can be chosen. A choice that was saved stays chosen (and says what is missing) when its connection is gone. */
  available: boolean;
  unavailable: Unavailable | null;
  /** The connection exists but its sign-in must be renewed (the account sync says so): the page offers «Reconnect». */
  reconnect: boolean;
}

/** What each of the four choices can do for a book, from the connections the author already has. */
export function choiceStates(book: BookEntry, settings: AppSettings, connections: LocalSyncConfiguration): ChoiceState[] {
  const github = bookStorageMode(book) === "github" && Boolean(book.owner && book.repo);
  const token = Boolean(resolveGitHubRemoteToken(book, settings));
  const renew = (status: string | undefined) => status === "needs-auth";
  return [
    { choice: "none", available: true, unavailable: null, reconnect: false },
    { choice: "github", available: github && token, unavailable: !github ? "noRepository" : !token ? "noToken" : null, reconnect: false },
    { choice: "google-drive", available: Boolean(connections.google), unavailable: connections.google ? null : "noConnection", reconnect: renew(connections.google?.replica.status) },
    { choice: "onedrive", available: Boolean(connections.microsoft), unavailable: connections.microsoft ? null : "noConnection", reconnect: renew(connections.microsoft?.replica.status) },
  ];
}

/** The service a sign-in belongs to, for «Reconnect <service>». */
export const SERVICE_NAME: Record<CopyTargetKind, string> = { github: "GitHub", "google-drive": "Google Drive", onedrive: "OneDrive" };

export type StatusLine =
  | { kind: "archive-full" }
  | { kind: "public-repository" }
  | { kind: "reconnect"; waiting: number }
  | { kind: "waiting"; waiting: number; reason: "offline" | "rate-limited" | "unavailable" | "failed" | null }
  | { kind: "idle"; copiedUpTo: string | null };

/** The one line that says what the copy is doing, most urgent first. */
export function statusLine(status: CopyStatus): StatusLine {
  if (status.warning === "archive-full") return { kind: "archive-full" };
  if (status.error === "public-repository") return { kind: "public-repository" };
  if (status.error === "reconnect") return { kind: "reconnect", waiting: status.waiting };
  if (status.waiting > 0) {
    const reason = status.offline ? "offline" : status.error === "rate-limited" || status.error === "unavailable" || status.error === "failed" ? status.error : status.error ? "failed" : null;
    return { kind: "waiting", waiting: status.waiting, reason };
  }
  return { kind: "idle", copiedUpTo: status.copiedUpTo };
}
