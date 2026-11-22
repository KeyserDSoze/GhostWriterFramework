import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, Pencil, Scale, Trash2 } from "lucide-react";
import { MAX_RULE_CHARACTERS } from "narrarium-engine";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/autopilot/Card";
import { loadAutopilotRuntime } from "@/autopilot/loader";
import { RULES_SERVER_VERSION, ruleErrorCode } from "@/autopilot/rules";
import type { useAutopilotActions } from "@/autopilot/useAutopilotActions";

type RunAction = ReturnType<typeof useAutopilotActions>["run"];

interface Editing {
  index: number;
  /** The rule as the author saw it when they started to edit it: the guard that keeps a rule changed in the meantime from being overwritten. */
  original: string;
  text: string;
}

/**
 * The permanent rules of the autopilot (`state.constraints`), to change and to remove. Every change carries the rule as the author saw it,
 * so that one changed in the meantime (on another device, by an answer to the director) is never overwritten: the refusal says so in the
 * author's words, next to the rules, and the list is read again. A rule over the limit of the engine is never sent. On a personal server
 * that predates the editing of the rules (`readOnly`) they are only listed, with the way to update the server.
 */
export function RulesEditor({ bookId, rules, readOnly, busy, run, liveHref }: { bookId: string; rules: readonly string[]; readOnly: boolean; busy: boolean; run: RunAction; liveHref: string }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const editButtons = useRef(new Map<number, HTMLButtonElement | null>());
  const editor = useRef<HTMLTextAreaElement | null>(null);
  const section = useRef<HTMLDivElement | null>(null);
  const [focusAfter, setFocusAfter] = useState<number | "list" | null>(null);
  const length = editing?.text.trim().length ?? 0;
  const tooLong = length > MAX_RULE_CHARACTERS;
  const editingIndex = editing ? editing.index : null;

  // The field takes the focus when it opens; once a rule is saved the focus goes back to it, and after a removal to the list.
  useEffect(() => {
    if (editingIndex !== null) editor.current?.focus();
  }, [editingIndex]);
  useEffect(() => {
    if (focusAfter === null || editing) return;
    if (focusAfter === "list") section.current?.closest<HTMLElement>("section")?.focus();
    else editButtons.current.get(focusAfter)?.focus();
    setFocusAfter(null);
  }, [focusAfter, editing]);

  /** A rule the engine refused: why, in the author's words. A rule that changed or went away elsewhere is read again; the author keeps what they wrote otherwise. */
  const refused = (error: unknown): boolean => {
    const code = ruleErrorCode(error);
    if (!code) return false;
    setMessage(t(`autopilot.config.rules.errors.${code}`, { max: MAX_RULE_CHARACTERS }));
    if (code === "rule_changed" || code === "rule_not_found") {
      setEditing(null);
      void loadAutopilotRuntime().then((runtime) => runtime.refresh(bookId)).catch(() => undefined);
    }
    return true;
  };

  const save = async () => {
    if (!editing || tooLong || !editing.text.trim()) return;
    const { index, original, text } = editing;
    setMessage(null);
    const ok = await run("configure", (runtime, id) => runtime.updateRule(id, index, text, original), t("autopilot.config.rules.saved"), refused);
    if (ok) {
      setEditing(null);
      setFocusAfter(index);
    }
  };

  const remove = async (index: number, text: string) => {
    if (!window.confirm(t("autopilot.config.rules.removeConfirm"))) return;
    setMessage(null);
    const ok = await run("configure", (runtime, id) => runtime.removeRule(id, index, text), t("autopilot.config.rules.removed"), refused);
    if (ok) setFocusAfter("list");
  };

  return (
    <Card id="autopilot-rules" title={t("autopilot.config.sections.rules")} icon={<Scale className="h-4 w-4 text-primary" aria-hidden="true" />}>
      <div ref={section} className="space-y-3">
        <p className="text-sm text-muted-foreground">{t("autopilot.config.rules.description")}</p>
        {readOnly && (
          <p role="note" className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-2 text-xs text-amber-800 dark:text-amber-300">
            {t("autopilot.config.rules.oldServer", { version: RULES_SERVER_VERSION })} <Link className="inline-flex min-h-6 items-center font-medium underline underline-offset-4" to="/app/settings/server">{t("personalServer.title")}</Link>
          </p>
        )}
        {message && <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive">{message}</p>}
        {rules.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("autopilot.config.rules.empty")}</p>
        ) : (
          <ol aria-label={t("autopilot.config.rules.listLabel")} className="space-y-2">
            {rules.map((rule, index) => {
              const number = index + 1;
              const open = editing?.index === index;
              const counterId = `autopilot-rule-${number}-count`;
              return (
                <li key={`${index}:${rule}`} className="space-y-2 rounded-lg border bg-background/60 p-3">
                  {open && editing ? (
                    <>
                      <label htmlFor={`autopilot-rule-${number}`} className="block text-xs font-medium text-muted-foreground">{t("autopilot.config.rules.rule", { number })}</label>
                      <AutoTextarea
                        ref={editor}
                        id={`autopilot-rule-${number}`}
                        value={editing.text}
                        minRows={2}
                        className="text-sm"
                        aria-describedby={counterId}
                        aria-invalid={tooLong || undefined}
                        disabled={busy}
                        onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                      />
                      <p id={counterId} className={tooLong ? "text-xs font-medium text-destructive" : "text-xs text-muted-foreground"}>{t("autopilot.config.rules.counter", { count: length, max: MAX_RULE_CHARACTERS })}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={busy || tooLong || !editing.text.trim()} onClick={() => void save()}>
                          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}{t("autopilot.config.rules.save")}
                        </Button>
                        <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setEditing(null); setMessage(null); setFocusAfter(index); }}>{t("autopilot.config.rules.cancel")}</Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <p data-rule-text className="whitespace-pre-wrap break-words text-sm">{rule}</p>
                      {!readOnly && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            ref={(node) => { editButtons.current.set(index, node); }}
                            size="sm"
                            variant="outline"
                            aria-label={t("autopilot.config.rules.editNamed", { number })}
                            disabled={busy || editing !== null}
                            onClick={() => { setMessage(null); setEditing({ index, original: rule, text: rule }); }}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />{t("autopilot.config.rules.edit")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={t("autopilot.config.rules.removeNamed", { number })}
                            disabled={busy || editing !== null}
                            onClick={() => void remove(index, rule)}
                          >
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />{t("autopilot.config.rules.remove")}
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        <p className="text-xs text-muted-foreground">
          {t("autopilot.config.rules.howToAdd")} <Link className="inline-flex min-h-6 items-center font-medium underline underline-offset-4" to={liveHref}>{t("autopilot.config.rules.openLive")}</Link>
        </p>
      </div>
    </Card>
  );
}
