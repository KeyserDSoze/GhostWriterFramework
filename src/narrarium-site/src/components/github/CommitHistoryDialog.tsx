import { useEffect, useState } from "react";
import { ExternalLink, GitCommit, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";
import { listBranchCommits, type BranchCommitSummary } from "@/github/githubClient";

export function CommitHistoryDialog(props: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}) {
  const { token, owner, repo, branch } = props;
  const { t } = useTranslation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [commits, setCommits] = useState<BranchCommitSummary[]>([]);

  useEffect(() => {
    if (!open || !token) return;
    setLoading(true);
    void listBranchCommits(token, owner, repo, branch)
      .then(setCommits)
      .catch((err) => {
        toast({ title: t("git.loadCommitsFailed"), description: String(err), variant: "destructive" });
      })
      .finally(() => setLoading(false));
  }, [open, token, owner, repo, branch, toast]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <GitCommit className="mr-1 h-4 w-4" />
          {t("git.commits")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("git.branchCommits")}</DialogTitle>
        </DialogHeader>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("git.loading")}</div>
        ) : commits.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("git.noCommits", { branch })}</p>
        ) : (
          <div className="space-y-2">
            {commits.map((commit) => (
              <div key={commit.sha} className="rounded-lg border p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{commit.message}</p>
                    <p className="font-mono text-[11px] text-muted-foreground">{commit.sha.slice(0, 7)}</p>
                    <p className="text-xs text-muted-foreground">{commit.authorName} · {new Date(commit.authoredAt).toLocaleString()}</p>
                  </div>
                  <Button asChild size="sm" variant="ghost">
                    <a href={commit.url} target="_blank" rel="noopener noreferrer">
                      <ExternalLink className="mr-1 h-4 w-4" />{t("git.open")}
                    </a>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
