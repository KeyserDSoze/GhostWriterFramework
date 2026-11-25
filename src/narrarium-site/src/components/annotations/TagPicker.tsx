import { useId } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/annotations";
import type { ResolvedTag } from "@/annotations/model";
import { cn } from "@/lib/utils";
import { TagLabel } from "@/components/annotations/TagLabel";

/** The tags of a book to choose from: radio buttons (the arrows move between them), each drawn with its mark; 44 px under a finger. */
export function TagPicker({ catalog, value, onChange, legend, name }: { catalog: readonly ResolvedTag[]; value: string; onChange: (id: string) => void; legend: string; name?: string }) {
  const { t } = useTranslation();
  const fallbackName = useId();
  const group = name ?? fallbackName;
  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-2">
        {catalog.map((tag) => {
          const id = `${group}-${tag.id}`;
          const checked = tag.id === value;
          return (
            <label
              key={tag.id}
              htmlFor={id}
              title={tag.description || undefined}
              className={cn(
                "inline-flex min-h-9 max-w-full cursor-pointer items-center gap-2 rounded-full border px-3 py-1 text-sm transition-colors [@media(pointer:coarse)]:min-h-11",
                "has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring has-[:focus-visible]:ring-offset-2",
                checked ? "border-primary bg-primary/10 font-medium" : "border-field hover:bg-accent/60",
              )}
            >
              <input
                id={id}
                type="radio"
                name={group}
                value={tag.id}
                checked={checked}
                onChange={() => onChange(tag.id)}
                className="sr-only"
                // A tag of the book says so after its name: the mark alone does not tell where a tag comes from.
                aria-label={tag.scope === "book" ? `${tag.name} (${t("annotations.tag.scope.book")})` : undefined}
              />
              <TagLabel tag={tag} />
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
