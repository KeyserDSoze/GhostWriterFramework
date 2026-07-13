import { useEffect, useState } from "react";
import type { BookEntry } from "@/types/settings";
import type { RewriteOperationScope } from "@/narrarium/rewriteOperationPaths";
import { loadLatestLocalRewriteOperation, LOCAL_REWRITE_OPERATIONS_CHANGED_EVENT } from "@/repository/localRewriteOperationStore";
import { getLocalRepository } from "@/repository/localRepository";

export function useHasLocalRewriteOperation(input: {
  book: BookEntry | undefined;
  branch: string;
  scope: RewriteOperationScope | null;
  chapterSlug?: string;
  paragraphSlug?: string;
}): boolean {
  const [hasOperation, setHasOperation] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const listener = () => setRevision((value) => value + 1);
    window.addEventListener(LOCAL_REWRITE_OPERATIONS_CHANGED_EVENT, listener);
    return () => window.removeEventListener(LOCAL_REWRITE_OPERATIONS_CHANGED_EVENT, listener);
  }, []);

  useEffect(() => {
    let active = true;
    if (!input.book || !input.scope || !input.chapterSlug || !input.branch) {
      setHasOperation(false);
      return () => { active = false; };
    }
    const book = input.book;
    const scope = input.scope;
    void getLocalRepository(book.owner, book.repo, input.branch).then((local) => {
      if (!local || local.cloneComplete !== true) return null;
      return loadLatestLocalRewriteOperation({
        bookId: book.id,
        owner: book.owner,
        repo: book.repo,
        branch: input.branch,
        scope,
        chapterSlug: input.chapterSlug,
        paragraphSlug: scope === "paragraph" ? input.paragraphSlug : undefined,
      });
    }).then((operation) => {
      if (active) setHasOperation(Boolean(operation));
    }).catch(() => {
      if (active) setHasOperation(false);
    });
    return () => { active = false; };
  }, [input.book?.id, input.book?.owner, input.book?.repo, input.branch, input.scope, input.chapterSlug, input.paragraphSlug, revision]);

  return hasOperation;
}
