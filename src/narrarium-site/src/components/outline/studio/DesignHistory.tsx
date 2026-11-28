import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { History, Loader2, RotateCcw, Save } from "lucide-react";
import { BookConflictError, DESIGN_HISTORY_DIR, designRestore, designSnapshotChange, readDesignSnapshot, type DesignRestoreItem, type DesignSnapshot } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { FileDiff } from "@/components/diff/DiffView";
import { formatDateTime } from "@/autopilot/format";
import { commitWithJournal } from "@/outline/outlineJournal";
import type { OutlineSource } from "@/outline/outlineSource";

export interface DesignHistoryProps {
  source: OutlineSource | null;
  refresh: () => Promise<void>;
  refreshKey: string;
  /** The language of the book: the journal of the Synopsis says the restore in it. */
  language?: string;
}

interface Version {
  path: string;
  snapshot: DesignSnapshot;
}

type Outcome = { kind: "saved" | "restored"; count?: number } | { kind: "conflict" | "failed" | "none" };

/** The versions the Studio lists at most, the newest first. */
const SHOWN = 20;

/** The Synopsis and the Bible as they are now, with the hash of each file: what a version keeps and what a restore compares. */
async function currentFiles(source: OutlineSource) {
  const [outline, bible] = await Promise.all([source.files(), source.readFolder ? source.readFolder("bible/") : Promise.resolve([])]);
  return [...outline, ...bible];
}

/**
 * The versions of the Synopsis and the Bible (Phase 4 of #108, `history/design/`): kept when the author approves a design, before the proposals of «Review and complete»
 * are applied, before a restore, and whenever the author saves one here. A version is compared with the files as they are now, file by file, and restored only once the
 * author has read what changes: the restore is one commit, which keeps the files as they were in a version of their own first.
 */
export default function DesignHistory({ source, refresh, refreshKey, language }: DesignHistoryProps) {
  const { t } = useTranslation();
  const id = useId();
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [compare, setCompare] = useState<{ path: string; items: DesignRestoreItem[] } | null>(null);
  const [asking, setAsking] = useState(false);
  const [working, setWorking] = useState<"save" | "compare" | "restore" | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  // Where the focus goes when what had it leaves the page: the question of a restore when it is asked, the button back when it is not, the outcome once restored.
  const [focus, setFocus] = useState<"ask" | "restore" | "outcome" | null>(null);
  const askRef = useRef<HTMLParagraphElement | null>(null);
  const restoreRef = useRef<HTMLButtonElement | null>(null);
  const outcomeRef = useRef<HTMLParagraphElement | null>(null);
  useEffect(() => {
    if (!focus) return;
    ({ ask: askRef, restore: restoreRef, outcome: outcomeRef })[focus].current?.focus();
    setFocus(null);
  }, [focus]);

  const load = useCallback(async () => {
    if (!source?.readFolder) return;
    const files = await source.readFolder(`${DESIGN_HISTORY_DIR}/`).catch(() => []);
    const read = files.map((file) => ({ path: file.path, snapshot: readDesignSnapshot(file.content) })).filter((version): version is Version => version.snapshot !== null);
    setVersions(read.sort((left, right) => right.snapshot.at.localeCompare(left.snapshot.at)));
  }, [source]);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const save = async () => {
    if (!source) return;
    setWorking("save");
    setOutcome(null);
    try {
      const change = designSnapshotChange(await currentFiles(source), { at: new Date().toISOString(), reason: "request" });
      if (!change) setOutcome({ kind: "none" });
      else {
        await source.commit([change], "Synopsis: save a version of the Synopsis and the Bible");
        setOutcome({ kind: "saved" });
        await load();
      }
    } catch (error) {
      setOutcome({ kind: error instanceof BookConflictError ? "conflict" : "failed" });
    } finally {
      setWorking(null);
    }
  };

  const showCompare = async (version: Version) => {
    if (!source) return;
    setOpen(version.path);
    setAsking(false);
    setOutcome(null);
    setWorking("compare");
    try {
      setCompare({ path: version.path, items: designRestore(version.snapshot, await currentFiles(source)).items });
    } catch {
      setOutcome({ kind: "failed" });
    } finally {
      setWorking(null);
    }
  };

  const restore = async (version: Version) => {
    if (!source) return;
    setWorking("restore");
    try {
      const now = await currentFiles(source);
      const { changes } = designRestore(version.snapshot, now);
      // The files as they are now are a version of their own, in the same commit: a restore can be taken back. The entries it changes are a series of the journal, by the author.
      const kept = designSnapshotChange(now, { at: new Date().toISOString(), reason: "restore" });
      await commitWithJournal(source, [...(kept ? [kept] : []), ...changes], `Synopsis: restore the version of ${version.snapshot.at}`, { by: "author", ...(language ? { language } : {}), note: `Restore the version of ${version.snapshot.at}` });
      setOutcome({ kind: "restored", count: changes.length });
      setCompare(null);
      setOpen(null);
      setAsking(false);
      setFocus("outcome");
      await refresh();
      await load();
    } catch (error) {
      setOutcome({ kind: error instanceof BookConflictError ? "conflict" : "failed" });
      await load();
    } finally {
      setWorking(null);
    }
  };

  const toggle = (version: Version) => {
    if (open !== version.path) {
      void showCompare(version);
      return;
    }
    setOpen(null);
    setCompare(null);
  };

  const shown = useMemo(() => (versions ?? []).slice(0, SHOWN), [versions]);
  if (!source?.readFolder) return null;
  return (
    <section aria-labelledby={`${id}-title`} data-design-history="" className="space-y-3 rounded-2xl border border-layer bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 id={`${id}-title`} className="flex items-center gap-2 text-base font-semibold"><History className="h-4 w-4 text-primary" aria-hidden="true" />{t("design.history.title")}</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">{t("design.history.intro")}</p>
        </div>
        <Button type="button" size="sm" variant="outline" data-history-save="" disabled={working !== null} onClick={() => void save()}>
          {working === "save" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}{t("design.history.save")}
        </Button>
      </div>
      {outcome && (
        <p ref={outcomeRef} tabIndex={-1} role="status" data-history-outcome={outcome.kind} className={`${outcome.kind === "conflict" || outcome.kind === "failed" ? "text-sm font-medium text-destructive" : "text-sm font-medium"} rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}>
          {t(`design.history.outcome.${outcome.kind}`, { count: "count" in outcome ? outcome.count ?? 0 : 0 })}
        </p>
      )}
      {versions === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("design.history.loading")}</p>
      ) : !versions.length ? (
        <p className="text-sm text-muted-foreground">{t("design.history.none")}</p>
      ) : (
        <ol className="space-y-2" aria-label={t("design.history.list")}>
          {shown.map((version) => (
            <li key={version.path} data-history-version={version.snapshot.reason} className="space-y-2 rounded-xl border bg-background/60 p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  <span className="font-medium">{formatDateTime(version.snapshot.at)}</span>
                  {" · "}{t(`design.history.reason.${version.snapshot.reason}`)}
                  {" · "}<span className="text-muted-foreground">{t("design.history.files", { count: Object.keys(version.snapshot.files).length })}</span>
                </span>
                <Button type="button" size="sm" variant="ghost" disabled={working !== null} aria-expanded={open === version.path} onClick={() => toggle(version)}>
                  {t(open === version.path ? "design.history.close" : "design.history.compare")}
                </Button>
              </div>
              {open === version.path && (
                <div data-history-compare="" className="space-y-2">
                  {working === "compare" || !compare || compare.path !== version.path ? (
                    <p className="flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("design.history.comparing")}</p>
                  ) : !compare.items.length ? (
                    <p>{t("design.history.same")}</p>
                  ) : (
                    <>
                      <p>{t("design.history.differences", { count: compare.items.length })}</p>
                      <ul className="space-y-1.5">
                        {compare.items.map((item) => (
                          <li key={item.path} data-history-item={item.kind}>
                            <details className="rounded-lg border border-layer">
                              <summary className="flex min-h-9 cursor-pointer flex-wrap items-center gap-2 rounded-lg px-3 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                                <span className="font-semibold">{t(`design.history.kind.${item.kind}`)}</span><code className="break-all">{item.path}</code>
                              </summary>
                              <FileDiff previous={item.before ?? ""} next={item.after ?? ""} className="m-2 max-h-80" />
                            </details>
                          </li>
                        ))}
                      </ul>
                      {asking ? (
                        <div role="group" aria-labelledby={`${id}-ask`} className="space-y-2 rounded-lg border border-layer p-3">
                          <p id={`${id}-ask`} ref={askRef} tabIndex={-1} className="rounded font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{t("design.history.ask", { count: compare.items.length })}</p>
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" size="sm" data-history-restore-confirm="" disabled={working !== null} onClick={() => void restore(version)}>
                              {working === "restore" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RotateCcw className="h-4 w-4" aria-hidden="true" />}{t("design.history.confirm")}
                            </Button>
                            <Button type="button" size="sm" variant="ghost" disabled={working !== null} onClick={() => { setAsking(false); setFocus("restore"); }}>{t("design.history.cancel")}</Button>
                          </div>
                        </div>
                      ) : (
                        <Button ref={restoreRef} type="button" size="sm" variant="outline" data-history-restore="" disabled={working !== null} onClick={() => { setAsking(true); setFocus("ask"); }}><RotateCcw className="h-4 w-4" aria-hidden="true" />{t("design.history.restore")}</Button>
                      )}
                    </>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {versions && versions.length > SHOWN && <p className="text-xs text-muted-foreground" data-history-older="">{t("design.history.older", { count: versions.length - SHOWN, folder: `${DESIGN_HISTORY_DIR}/` })}</p>}
    </section>
  );
}
