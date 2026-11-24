import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Eye, EyeOff, Loader2, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { generateReaderPassword, readerPasswordBits, readerPasswordProblem, readerPasswordStrength, READER_PASSWORD_MIN } from "@/readerAccess/passwords";

interface Props {
  busy: boolean;
  /** Why passwords cannot be added now (the workflow of the repository does not read them): the form is shown, disabled, with this said. */
  blockedReason?: string;
  onAdd: (input: { label: string; value: string }) => Promise<unknown>;
}

/** The form that adds a password: a label, the password (typed, or made by the generator), a strength reading, and the warning that the published book can be tried offline. */
export function AddPasswordForm({ busy, blockedReason, onAdd }: Props) {
  const { t } = useTranslation();
  const ids = { label: useId(), value: useId(), help: useId(), strength: useId() };
  const [label, setLabel] = useState("");
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const blocked = Boolean(blockedReason);
  const problem = value ? readerPasswordProblem(value) : null;
  const strength = value && !problem ? readerPasswordStrength(value) : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || blocked || !value || problem) return;
    const outcome = await onAdd({ label: label.trim() || t("readerAccess.defaultLabel"), value }) as { ok?: boolean } | null;
    // A password that was kept (even if a later step failed) is in the list now: the form is clear for the next one.
    if (outcome && (outcome.ok || (outcome as { done?: string[] }).done?.includes("save"))) { setLabel(""); setValue(""); setShown(false); }
  }

  return (
    <form className="space-y-3" onSubmit={(event) => void submit(event)} aria-labelledby={`${ids.label}-title`}>
      <h3 id={`${ids.label}-title`} className="text-sm font-medium">{t("readerAccess.addTitle")}</h3>
      {blockedReason && <p role="status" className="rounded-md border border-amber-600/50 bg-amber-50 p-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200" data-testid="reader-add-blocked">{blockedReason}</p>}
      <div className="grid gap-2 sm:max-w-md">
        <Label htmlFor={ids.label}>{t("readerAccess.labelField")}</Label>
        <Input id={ids.label} value={label} maxLength={60} disabled={busy || blocked} placeholder={t("readerAccess.labelPlaceholder")} onChange={(event) => setLabel(event.target.value)} />
      </div>
      <div className="grid gap-2 sm:max-w-md">
        <Label htmlFor={ids.value}>{t("readerAccess.passwordField")}</Label>
        <div className="flex gap-2">
          <Input id={ids.value} type={shown ? "text" : "password"} autoComplete="off" spellCheck={false} value={value} disabled={busy || blocked} aria-invalid={problem ? true : undefined} aria-describedby={`${ids.help} ${ids.strength}`} onChange={(event) => setValue(event.target.value)} />
          <Button type="button" variant="outline" size="icon" aria-pressed={shown} aria-label={shown ? t("readerAccess.hideNew") : t("readerAccess.revealNew")} disabled={busy || blocked} onClick={() => setShown((current) => !current)}>
            {shown ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" size="sm" disabled={busy || blocked} onClick={() => { setValue(generateReaderPassword()); setShown(true); }}>
            <Sparkles aria-hidden="true" className="mr-1 h-4 w-4" />{t("readerAccess.generate")}
          </Button>
        </div>
        <p id={ids.strength} role="status" className="text-xs">
          {problem ? <span className="text-destructive">{t(`readerAccess.problem.${problem}`, { min: READER_PASSWORD_MIN })}</span>
            : strength ? <span>{t("readerAccess.strength.label")}: <strong>{t(`readerAccess.strength.${strength}`)}</strong> ({t("readerAccess.strength.bits", { bits: readerPasswordBits(value) })})</span>
              : <span className="text-muted-foreground">{t("readerAccess.strength.none")}</span>}
        </p>
        <p id={ids.help} className="text-xs text-muted-foreground">{t("readerAccess.offlineWarning")}</p>
      </div>
      <Button type="submit" disabled={busy || blocked || !value || Boolean(problem)}>
        {busy ? <Loader2 aria-hidden="true" className="mr-1 h-4 w-4 animate-spin motion-reduce:animate-none" /> : <Plus aria-hidden="true" className="mr-1 h-4 w-4" />}{busy ? t("readerAccess.adding") : t("readerAccess.add")}
      </Button>
    </form>
  );
}
