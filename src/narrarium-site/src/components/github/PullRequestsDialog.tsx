import { useEffect, useState } from "react";
import { ExternalLink, GitPullRequest, Loader2, Merge, Plus, XCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import {
  closePullRequest,
  createPullRequest,
  listOpenPullRequests,
  mergePullRequest,
  type PullRequestSummary,
} from "@/github/githubClient";

export function PullRequestsDialog(props: {
  token: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
}) {
  const { token, owner, repo, head, base } = props;
  const { t } = useTranslation();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pulls, setPulls] = useState<PullRequestSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [actingNumber, setActingNumber] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  async function loadPulls() {
    if (!token) return;
    setLoading(true);
    try {
      const items = await listOpenPullRequests(token, owner, repo, head);
      setPulls(items);
    } catch (err) {
      toast({ title: t("git.loadPrsFailed"), description: String(err), variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open || !token) return;
    void loadPulls();
  }, [open, token, owner, repo, head]);

  async function handleCreate() {
    if (!title.trim()) return;
    setCreating(true);
    try {
      const pr = await createPullRequest(token, owner, repo, {
        head,
        base,
        title: title.trim(),
        body: body.trim() || undefined,
      });
      setPulls((current) => [pr, ...current]);
      setTitle("");
      setBody("");
      toast({ title: t("git.prCreated", { number: pr.number }) });
    } catch (err) {
      toast({ title: t("git.createPrFailed"), description: String(err), variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  async function handleClose(pr: PullRequestSummary) {
    setActingNumber(pr.number);
    try {
      await closePullRequest(token, owner, repo, pr.number);
      setPulls((current) => current.filter((entry) => entry.number !== pr.number));
      toast({ title: t("git.prClosed", { number: pr.number }) });
    } catch (err) {
      toast({ title: t("git.closePrFailed"), description: String(err), variant: "destructive" });
    } finally {
      setActingNumber(null);
    }
  }

  async function handleMerge(pr: PullRequestSummary) {
    setActingNumber(pr.number);
    try {
      await mergePullRequest(token, owner, repo, pr.number, pr.title);
      setPulls((current) => current.filter((entry) => entry.number !== pr.number));
      toast({ title: t("git.prMerged", { number: pr.number }) });
    } catch (err) {
      toast({ title: t("git.mergePrFailed"), description: String(err), variant: "destructive" });
    } finally {
      setActingNumber(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <GitPullRequest className="mr-1 h-4 w-4" />
          {t("git.prs")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("git.pullRequests")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
            {t("git.currentBranch")} <strong>{head}</strong><br />
            {t("git.baseBranch")} <strong>{base}</strong>
          </div>

          <div className="space-y-2">
            <Input placeholder={t("git.prTitlePlaceholder")} value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea placeholder={t("git.prDescriptionPlaceholder")} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">{t("git.openPrs")}</p>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("git.loading")}</div>
            ) : pulls.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("git.noPrs", { head })}</p>
            ) : (
              <div className="space-y-2">
                {pulls.map((pr) => (
                  <div key={pr.number} className="rounded-lg border p-3 text-sm space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">#{pr.number} {pr.title}</p>
                        <p className="text-xs text-muted-foreground">{pr.head} -&gt; {pr.base}</p>
                      </div>
                      <Button asChild size="sm" variant="ghost">
                        <a href={pr.htmlUrl} target="_blank" rel="noopener noreferrer">
                          <ExternalLink className="mr-1 h-4 w-4" />{t("git.open")}
                        </a>
                      </Button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" variant="outline" onClick={() => void handleMerge(pr)} disabled={actingNumber === pr.number}>
                        {actingNumber === pr.number ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Merge className="mr-1 h-4 w-4" />}
                        {t("git.merge")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => void handleClose(pr)} disabled={actingNumber === pr.number}>
                        {actingNumber === pr.number ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <XCircle className="mr-1 h-4 w-4" />}
                        {t("git.close")}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>{t("git.close")}</Button>
          <Button onClick={() => void handleCreate()} disabled={creating || !title.trim() || head === base}>
            {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
            {t("git.createPr")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
