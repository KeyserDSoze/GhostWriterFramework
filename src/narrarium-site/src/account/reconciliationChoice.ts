import type { AccountSyncBackendKind, AccountSyncManifest } from "@/account/types";
import { compareVectorClocks } from "@/account/vectorClock";

export type ReconciliationCandidateId = "local" | AccountSyncBackendKind;

export interface ReconciliationChoiceInput {
  id: ReconciliationCandidateId;
  snapshot: { manifest: AccountSyncManifest };
}

export interface RankedReconciliationCandidate {
  id: ReconciliationCandidateId;
  /** When the copy was last modified (`manifest.modifiedAtUtc`), as an instant; `null` when the manifest carries no readable date. */
  modifiedAtMs: number | null;
  /** True when another copy is causally ahead of this one (its vector clock includes everything this one has): it can never be the newest. */
  superseded: boolean;
  newest: boolean;
}

/** The order that settles a tie between two copies modified at the very same instant: this device first (nothing is downloaded), then the services. */
const TIE_ORDER: Record<ReconciliationCandidateId, number> = { local: 0, github: 1, "google-drive": 2, onedrive: 3 };

function instant(manifest: AccountSyncManifest): number | null {
  const parsed = Date.parse(manifest.modifiedAtUtc);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Later dates first, a copy without a readable date after every dated one. */
function laterFirst(left: number | null, right: number | null): number {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return right - left;
}

/**
 * Which of the copies that differ is the newest. «Newest» is the latest `modifiedAtUtc` that the manifest of each copy carries: the time of the last
 * change made on the device that wrote it. Vector clocks only order copies partially (two devices that edited on their own are concurrent, and that is
 * exactly why the owner is asked), so they are used for one thing: a copy that another copy has strictly caught up with is superseded and is never the
 * newest, whatever its date says. Among the rest the latest date wins; a copy without a readable date ranks last. When two dates are the same
 * instant, this device wins, then GitHub, Google Drive, OneDrive, and finally the smaller snapshot id, so the same copies always give the same answer.
 * The newest copy is only the one proposed first: nothing is overwritten until the owner confirms.
 */
export function rankReconciliationCandidates(candidates: readonly ReconciliationChoiceInput[]): RankedReconciliationCandidate[] {
  const ranked = candidates.map((candidate) => ({
    id: candidate.id,
    snapshotId: candidate.snapshot.manifest.snapshotId,
    modifiedAtMs: instant(candidate.snapshot.manifest),
    superseded: candidates.some((other) => other !== candidate && compareVectorClocks(other.snapshot.manifest.vectorClock, candidate.snapshot.manifest.vectorClock) === "ahead"),
  }));
  const order = [...ranked].sort((left, right) =>
    Number(left.superseded) - Number(right.superseded)
    || laterFirst(left.modifiedAtMs, right.modifiedAtMs)
    || TIE_ORDER[left.id] - TIE_ORDER[right.id]
    || (left.snapshotId < right.snapshotId ? -1 : left.snapshotId > right.snapshotId ? 1 : 0));
  const first = order[0]?.id;
  return order.map(({ id, modifiedAtMs, superseded }) => ({ id, modifiedAtMs, superseded, newest: id === first }));
}

/** The copy to propose first, or `null` when there is nothing to choose from. */
export function newestReconciliationCandidate(candidates: readonly ReconciliationChoiceInput[]): ReconciliationCandidateId | null {
  return rankReconciliationCandidates(candidates)[0]?.id ?? null;
}
