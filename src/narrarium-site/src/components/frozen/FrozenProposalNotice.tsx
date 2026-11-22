import "@/i18n/frozenCopilot";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Lock, LockOpen } from "lucide-react";
import type { FrozenEditsMode } from "narrarium-engine";
import type { FrozenProposalNotice as Notice, ProposedFile } from "@/frozen/proposal";
import { chapterTextFile } from "@/frozen/chapterText";
import type { BookEntry } from "@/types/settings";

/**
 * Under a proposal of the Copilot: the frozen chapters whose text it changes, and what will happen after it is applied (the author is asked
 * whether to review the chapter, the autopilot reviews it, or only reports it, as its Configuration says), or that it takes a freeze away. A
 * proposal that touches no chapter's text reads nothing; the rest is read in the book's working copy, once for each proposal.
 */
export function FrozenProposalNotice({ book, branch, files }: { book: BookEntry | undefined; branch: string; files: readonly ProposedFile[] }) {
  const { t } = useTranslation();
  const touched = files.filter((file) => chapterTextFile(file.path)).map((file) => `${file.path}:${file.body?.length ?? file.content?.length ?? "deleted"}`).join("|");
  const latest = useRef(files);
  latest.current = files;
  const [found, setFound] = useState<{ key: string; notices: Notice[]; mode: FrozenEditsMode } | null>(null);
  const bookKey = book ? `${book.id}|${book.owner}/${book.repo}` : "";
  const bookRef = useRef(book);
  bookRef.current = book;

  useEffect(() => {
    const entry = bookRef.current;
    if (!entry || !touched) return;
    let current = true;
    void import("@/frozen/proposal")
      .then(({ readFrozenProposal }) => readFrozenProposal(entry, branch, latest.current))
      .then((result) => { if (current) setFound({ key: `${bookKey}|${branch}|${touched}`, ...result }); })
      // A chapter that cannot be read is not said to be frozen: the proposal is shown as it always was.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [bookKey, branch, touched]);

  if (!found || found.key !== `${bookKey}|${branch}|${touched}` || !found.notices.length) return null;
  return (
    <ul data-frozen-proposal className="mt-2 space-y-1">
      {found.notices.map((notice) => (
        <li key={notice.slug} className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-foreground">
          {notice.kind === "unfrozen" ? <LockOpen className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" /> : <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
          <span>{t(notice.kind === "unfrozen" ? "frozen.copilot.unfrozen" : `frozen.copilot.${found.mode}`, { number: notice.number ?? notice.slug })}</span>
        </li>
      ))}
    </ul>
  );
}
