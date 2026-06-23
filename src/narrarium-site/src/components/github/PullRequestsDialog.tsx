import { useEffect, useState } from "react";
import { ExternalLink, GitPullRequest, Loader2, Plus } from "lucide-react";
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
import { createPullRequest, listOpenPullRequests, type PullRequestSummary } from "@/github/githubClient";

export function PullRequestsDialog(props: {
  token: string;
  owner: string;
  repo: string;
  head: string;
  base: string;
}) {
  const { token, owner, repo, head, base } = props;
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [pulls, setPulls] = useState<PullRequestSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");

  useEffect(() => {
    if (!open || !token) return;
    setLoading(true);
    void listOpenPullRequests(token, owner, repo, head)
      .then(setPulls)
      .catch((err) => {
        toast({ title: "Failed to load PRs", description: String(err), variant: "destructive" });
      })
      .finally(() => setLoading(false));
  }, [open, token, owner, repo, head, toast]);

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
      toast({ title: `PR #${pr.number} created` });
    } catch (err) {
      toast({ title: "Create PR failed", description: String(err), variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <GitPullRequest className="mr-1 h-4 w-4" />
          PRs
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Pull requests</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border bg-muted/20 p-3 text-xs text-muted-foreground">
            Current branch: <strong>{head}</strong><br />
            Base branch: <strong>{base}</strong>
          </div>

          <div className="space-y-2">
            <Input placeholder="PR title" value={title} onChange={(e) => setTitle(e.target.value)} />
            <Textarea placeholder="Description (optional)" rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Open PRs for this branch</p>
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
            ) : pulls.length === 0 ? (
              <p className="text-sm text-muted-foreground">No open PRs for {head}.</p>
            ) : (
              <div className="space-y-2">
                {pulls.map((pr) => (
                  <div key={pr.number} className="flex items-center justify-between rounded-lg border p-3 text-sm">
                    <div>
                      <p className="font-medium">#{pr.number} {pr.title}</p>
                      <p className="text-xs text-muted-foreground">{pr.head} -&gt; {pr.base}</p>
                    </div>
                    <Button asChild size="sm" variant="ghost">
                      <a href={pr.htmlUrl} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="mr-1 h-4 w-4" />Open
                      </a>
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Close</Button>
          <Button onClick={() => void handleCreate()} disabled={creating || !title.trim() || head === base}>
            {creating ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
            Create PR
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
