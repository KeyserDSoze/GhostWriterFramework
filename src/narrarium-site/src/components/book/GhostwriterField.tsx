import { useTranslation } from "react-i18next";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Ghostwriter } from "@/types/book";

export function GhostwriterField({
  ghostwriters,
  value,
  onChange,
}: {
  ghostwriters: Ghostwriter[];
  value: string;
  onChange: (slug: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3">
      <span className="w-20 shrink-0 font-mono text-[11px]">{t("pipeline.ghostwriter")}</span>
      <Select value={value || "__default__"} onValueChange={(v) => onChange(v === "__default__" ? "" : v)}>
        <SelectTrigger className="h-8 flex-1 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__default__">{t("pipeline.defaultStyle")}</SelectItem>
          {ghostwriters.map((g) => <SelectItem key={g.slug} value={g.slug}>{g.name}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
