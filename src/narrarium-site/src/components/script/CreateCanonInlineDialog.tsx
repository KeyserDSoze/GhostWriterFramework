import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { resolveBookToken } from "@/types/settings";
import { createCanonEntity, type EntityKind } from "@/narrarium/canon";

export function CreateCanonInlineDialog({
  bookId,
  kind,
  onCreated,
}: {
  bookId: string | undefined;
  kind: EntityKind;
  onCreated: (id: string, label: string) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [stakes, setStakes] = useState("");
  const [busy, setBusy] = useState(false);

  async function create() {
    if (!book || !token || !name.trim()) return;
    setBusy(true);
    try {
      const extra =
        kind === "timeline-event" && date.trim()
          ? { date: date.trim() }
          : kind === "secret" && stakes.trim()
            ? { stakes: stakes.trim() }
            : undefined;
      const created = await createCanonEntity(token, book.owner, book.repo, branch, { kind, label: name.trim(), extraFrontmatter: extra });
      onCreated(created.id, name.trim());
      toast({ title: t("script.canonCreated", { name: name.trim() }) });
      setOpen(false);
      setName("");
      setDate("");
      setStakes("");
      void reload();
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  const titleKey =
    kind === "character" ? "script.newCharacter"
    : kind === "location" ? "script.newLocation"
    : kind === "item" ? "script.newItem"
    : kind === "faction" ? "script.newFaction"
    : kind === "secret" ? "script.newSecret"
    : "script.newTimeline";

  return (
    <>
      <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" title={t(titleKey)} onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>{t(titleKey)}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs">{t("script.canonName")}</Label>
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void create(); }} />
            </div>
            {kind === "timeline-event" && (
              <div className="space-y-1">
                <Label className="text-xs">{t("script.date")}</Label>
                <Input value={date} onChange={(e) => setDate(e.target.value)} />
              </div>
            )}
            {kind === "secret" && (
              <div className="space-y-1">
                <Label className="text-xs">{t("script.secretStakes")}</Label>
                <Input value={stakes} onChange={(e) => setStakes(e.target.value)} placeholder={t("script.secretStakesPlaceholder")} />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>{t("common.cancel")}</Button>
            <Button onClick={() => void create()} disabled={busy || !name.trim()}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{t("common.add")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
