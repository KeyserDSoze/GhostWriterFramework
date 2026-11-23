import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { knownLanguage, languageLabel, languageOptions, languageValue } from "@/director/sheetModel";

/**
 * The language of the director, chosen among the languages the engine knows (the book's first, each with its own name in its own script and
 * read in it), and kept as it is written when the file says one the engine does not know. The engine writes the director's opinions in the
 * language of the book whatever this says, and the field says so.
 */
export function LanguageField({ value, bookLanguage, onChange }: { value: string; bookLanguage: string | undefined; onChange: (code: string) => void }) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const ui = i18n.resolvedLanguage ?? i18n.language ?? "en";
  const options = useMemo(() => languageOptions(ui, bookLanguage, value), [ui, bookLanguage, value]);
  const book = knownLanguage(bookLanguage) ?? "en";
  return (
    <div className="space-y-1.5">
      <Label id={`${id}-label`}>{t("director.language")}</Label>
      <Select value={languageValue(value)} onValueChange={onChange}>
        <SelectTrigger aria-labelledby={`${id}-label`} aria-describedby={`${id}-hint`} className="h-11 sm:h-10"><SelectValue /></SelectTrigger>
        <SelectContent className="max-h-80">
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.unknown ? t("director.languageUnknown", { value: option.value }) : (
                <>
                  {option.name}
                  {option.native && <> — <span lang={option.value}>{option.native}</span></>}
                  {` (${option.value})`}
                  {option.book && ` · ${t("director.languageBook")}`}
                </>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t("director.languageHint", { language: languageLabel(book, ui) })}</p>
    </div>
  );
}
