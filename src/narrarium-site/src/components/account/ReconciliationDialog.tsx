import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import "@/i18n/accountReconcile";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LocalTime } from "@/components/ui/local-time";
import { resolveAccountReconciliation, useAccountSyncStore, type ReplicaCandidate } from "@/account/accountSync";
import { rankReconciliationCandidates, type ReconciliationCandidateId } from "@/account/reconciliationChoice";

/**
 * Asks which copy of the account data to keep when the device and the services hold different ones. The newest copy (see `rankReconciliationCandidates`)
 * is listed first, labelled in words and already selected, so the usual answer is one press of «Use the newest copy»; the other copies stay a choice away.
 * Nothing is written until the button is pressed.
 */
export function ReconciliationDialog() {
  const { t } = useTranslation();
  const reconciliation = useAccountSyncStore((state) => state.reconciliation);
  const setReconciliation = useAccountSyncStore((state) => state.setReconciliation);
  const [selection, setSelection] = useState<{ request: unknown; id: ReconciliationCandidateId } | null>(null);
  const [resolving, setResolving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groupName = useId();

  const ranking = useMemo(() => (reconciliation ? rankReconciliationCandidates(reconciliation.candidates) : []), [reconciliation]);
  const byId = new Map<ReconciliationCandidateId, ReplicaCandidate>((reconciliation?.candidates ?? []).map((candidate) => [candidate.id, candidate]));
  const newestId = ranking[0]?.id ?? null;
  const chosenId = selection && selection.request === reconciliation && byId.has(selection.id) ? selection.id : newestId;
  const nameOf = (candidate: ReplicaCandidate) => (candidate.id === "local" ? t("accountSync.reconcile.local") : candidate.label);

  async function apply() {
    if (!chosenId) return;
    setResolving(true);
    setError(null);
    try { await resolveAccountReconciliation(chosenId); }
    catch (cause) { setError(t("accountSync.reconcile.failed", { error: cause instanceof Error ? cause.message : String(cause) })); }
    finally { setResolving(false); }
  }

  const chosen = chosenId ? byId.get(chosenId) : undefined;
  return (
    <Dialog open={Boolean(reconciliation)} onOpenChange={(open) => { if (!open && !resolving) { setReconciliation(null); setError(null); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("accountSync.reconcile.title")}</DialogTitle>
          <DialogDescription>{t("accountSync.reconcile.intro")}</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2" disabled={resolving}>
          <legend className="mb-2 text-sm font-medium">{t("accountSync.reconcile.legend")}</legend>
          {ranking.map((entry) => {
            const candidate = byId.get(entry.id);
            if (!candidate) return null;
            const manifest = candidate.snapshot.manifest;
            const selected = entry.id === chosenId;
            return (
              <label key={entry.id} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 focus-within:ring-2 focus-within:ring-ring ${selected ? "border-primary bg-accent" : "hover:bg-accent"}`}>
                <input type="radio" className="mt-1 h-4 w-4 shrink-0" name={groupName} value={entry.id} checked={selected} onChange={() => setSelection({ request: reconciliation, id: entry.id })} />
                <span className="min-w-0 space-y-0.5">
                  <span className="flex flex-wrap items-center gap-2">
                    <strong>{nameOf(candidate)}</strong>
                    {entry.newest && <>{" "}<span className="rounded-full border border-primary px-2 py-0.5 text-xs font-semibold">{t("accountSync.reconcile.newest")}</span></>}
                    {entry.superseded && <>{" "}<span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">{t("accountSync.reconcile.superseded")}</span></>}
                  </span>{" "}
                  <span className="block text-xs text-muted-foreground">
                    {t("accountSync.reconcile.modified")}: {entry.modifiedAtMs === null ? t("accountSync.reconcile.unknownDate") : <LocalTime value={manifest.modifiedAtUtc} />}
                    {" · "}{t("accountSync.reconcile.device", { device: manifest.modifiedByDeviceId })}
                    {" · "}{t("accountSync.local.books", { count: candidate.snapshot.data.settings.books.length })}
                    {" · "}{t("accountSync.local.chats", { count: candidate.snapshot.data.chats.length })}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        <div role="alert" className="text-sm text-destructive">{error}</div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { setReconciliation(null); setError(null); }} disabled={resolving}>{t("common.cancel")}</Button>
          <Button onClick={() => void apply()} disabled={resolving || !chosen}>
            {resolving && <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" />}
            {resolving ? t("accountSync.reconcile.using") : chosenId === newestId ? t("accountSync.reconcile.useNewest") : t("accountSync.reconcile.useSelected", { name: chosen ? nameOf(chosen) : "" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
