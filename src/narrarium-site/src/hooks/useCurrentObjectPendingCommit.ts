import { useEffect, useMemo, useState } from "react";
import { getLocalFileEntry, getLocalRepository } from "@/repository/localRepository";
import type { BookEntry } from "@/types/settings";

export function useCurrentObjectPendingCommit(input: {
  book: BookEntry | undefined;
  branch: string;
  paths: string[];
}): { pending: boolean; count: number; paths: string[] } {
  const pathKey = input.paths.filter(Boolean).join("|");
  const normalizedPaths = useMemo(() => [...new Set(input.paths.filter(Boolean))], [pathKey]);
  const [state, setState] = useState<{ pending: boolean; count: number; paths: string[] }>({ pending: false, count: 0, paths: [] });

  useEffect(() => {
    let active = true;
    if (!input.book || !input.branch || normalizedPaths.length === 0) {
      setState({ pending: false, count: 0, paths: [] });
      return () => { active = false; };
    }

    async function refresh() {
      const repo = await getLocalRepository(input.book!.owner, input.book!.repo, input.branch).catch(() => null);
      if (!repo) {
        if (active) setState({ pending: false, count: 0, paths: [] });
        return;
      }
      const files = await Promise.all(normalizedPaths.map((path) => getLocalFileEntry(repo.id, path).catch(() => null)));
      const pendingPaths = normalizedPaths.filter((_path, index) => {
        const file = files[index];
        return Boolean(file && file.status !== "clean" && !file.committed);
      });
      if (active) setState({ pending: pendingPaths.length > 0, count: pendingPaths.length, paths: pendingPaths });
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { active = false; window.clearInterval(timer); };
  }, [input.book?.id, input.book?.owner, input.book?.repo, input.branch, pathKey]);

  return state;
}
