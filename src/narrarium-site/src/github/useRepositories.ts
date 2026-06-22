import { useState, useEffect, useCallback } from "react";
import { listUserRepos, RepoSummary } from "./githubClient";

export function useRepositories(token: string | undefined) {
  const [repos, setRepos] = useState<RepoSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetch = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const data = await listUserRepos(token);
      setRepos(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load repositories");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void fetch();
  }, [fetch]);

  return { repos, loading, error, refetch: fetch };
}
