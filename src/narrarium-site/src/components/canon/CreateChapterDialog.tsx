import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface CreateChapterDialogProps {
  nextNumber: number;
  onCreate: (input: { number: number; title: string; summary?: string }) => Promise<void>;
}

export function CreateChapterDialog({ nextNumber, onCreate }: CreateChapterDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [number, setNumber] = useState(nextNumber);
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setNumber(nextNumber);
    setTitle("");
    setSummary("");
    setError(null);
  }

  async function submit() {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate({ number, title: title.trim(), summary: summary.trim() || undefined });
      setOpen(false);
      reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("createDialogs.createChapterFailed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="mr-1 h-4 w-4" />
          {t("createDialogs.addChapter")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createDialogs.newChapter")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-[100px_1fr] gap-3">
            <div className="grid gap-2">
              <Label htmlFor="chapter-number">{t("createDialogs.number")}</Label>
              <Input
                id="chapter-number"
                type="number"
                min={1}
                value={number}
                onChange={(e) => setNumber(Math.max(1, Number(e.target.value) || 1))}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="chapter-title">{t("createDialogs.title")}</Label>
              <Input
                id="chapter-title"
                autoFocus
                placeholder={t("createDialogs.titlePlaceholder")}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void submit();
                }}
              />
            </div>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="chapter-summary">{t("createDialogs.summaryOptional")}</Label>
            <Textarea
              id="chapter-summary"
              rows={3}
              placeholder={t("createDialogs.summaryPlaceholder")}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
            {t("common.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !title.trim()}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
            {t("common.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
