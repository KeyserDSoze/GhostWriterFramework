import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import "@/i18n/readerAccess";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { RevealablePassword } from "@/components/book/readerAccess/RevealablePassword";
import { templateSupportsReaderPasswords } from "@/readerAccess/capability";
import { generateReaderPassword } from "@/readerAccess/passwords";

export type ReaderKind = "public" | "protected";

/** Whether the workflow that the new repository gets can honour passwords: read from the template, when the choice is first wanted. `unknown` until it has been read. */
export function useReaderPasswordSupport(enabled: boolean): "unknown" | "yes" | "no" {
  const [support, setSupport] = useState<"unknown" | "yes" | "no">("unknown");
  useEffect(() => {
    if (!enabled || support !== "unknown") return undefined;
    let cancelled = false;
    void import("@/narrarium/bookTemplate").then(async (module) => {
      const template = await module.loadBookTemplate();
      if (!cancelled) setSupport(templateSupportsReaderPasswords(template) ? "yes" : "no");
    }).catch(() => { if (!cancelled) setSupport("no"); });
    return () => { cancelled = true; };
  }, [enabled, support]);
  return support;
}

const CHOICE = "flex cursor-pointer items-start gap-3 rounded-lg border p-3";

interface Props {
  reader: ReaderKind;
  password: string;
  disabled?: boolean;
  onChange: (change: { reader?: ReaderKind; password?: string }) => void;
}

/**
 * «Public reader / protected by a password», under «Turn on GitHub Pages». A protected reader gets a strong first password made here, shown (masked until
 * asked for, with Copy) and kept in the account data; it is put on GitHub right after the repository exists and before the workflow, so the first publication
 * already asks for it. More passwords are added later in Reader access.
 */
export function ReaderChoice({ reader, password, disabled, onChange }: Props) {
  const { t } = useTranslation();
  const base = useId();
  // The password is made when «protected» is the choice and there is none yet (and again on request).
  useEffect(() => { if (reader === "protected" && !password) onChange({ password: generateReaderPassword() }); }, [reader, password]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <fieldset className="space-y-2 sm:max-w-xl" disabled={disabled} data-testid="reader-choice">
      <legend className="text-sm font-medium">{t("github.createBook.reader.legend")}</legend>
      {(["protected", "public"] as const).map((value) => (
        <label key={value} className={cn(CHOICE, reader === value ? "border-primary/60 bg-primary/5" : "hover:bg-muted/40")}>
          <input type="radio" name={`${base}-reader`} value={value} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" checked={reader === value} aria-labelledby={`${base}-${value}-name`} aria-describedby={`${base}-${value}-hint`} onChange={() => onChange({ reader: value })} />
          <span className="min-w-0 space-y-1">
            <span id={`${base}-${value}-name`} className="block text-sm font-medium">{t(`github.createBook.reader.${value}`)}</span>
            <span id={`${base}-${value}-hint`} className="block text-xs text-muted-foreground">{t(`github.createBook.reader.${value}Hint`)}</span>
          </span>
        </label>
      ))}
      {reader === "protected" && password && (
        <div className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">{t("github.createBook.reader.passwordTitle")}</p>
          <RevealablePassword value={password} label={t("github.createBook.reader.firstLabel")} />
          <p className="text-xs text-muted-foreground">{t("github.createBook.reader.passwordHint")}</p>
          <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={() => onChange({ password: generateReaderPassword() })}><Sparkles aria-hidden="true" className="mr-1 h-4 w-4" />{t("readerAccess.generate")}</Button>
        </div>
      )}
    </fieldset>
  );
}
