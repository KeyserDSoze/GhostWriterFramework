import { useTranslation } from "react-i18next";
import { Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { Ghostwriter } from "@/types/book";

export interface GeneratePreviewProps {
  open: boolean;
  title: string;
  description: string;
  text: string;
  loading: boolean;
  ghostwriters: Ghostwriter[];
  ghostwriter: string;
  onGhostwriter: (slug: string) => void;
  onRegenerate: () => void;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

export function GeneratePreviewDialog(props: GeneratePreviewProps) {
  const { t } = useTranslation();
  const hasText = props.text.trim().length > 0;
  return (
    <Dialog open={props.open} onOpenChange={(next) => { if (!next) props.onCancel(); }}>
      <DialogContent className="left-1/2 top-1/2 flex h-[88dvh] max-h-[88dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col p-0 sm:w-[760px]">
        <div className="border-b px-4 py-3">
          <p className="font-semibold">{props.title}</p>
          <p className="text-xs text-muted-foreground">{props.description}</p>
        </div>
        <div className="flex items-center gap-2 border-b px-4 py-2">
          <span className="text-xs text-muted-foreground">{t("pipeline.ghostwriter")}</span>
          <Select value={props.ghostwriter || "__default__"} onValueChange={(v) => props.onGhostwriter(v === "__default__" ? "" : v)}>
            <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">{t("pipeline.defaultStyle")}</SelectItem>
              {props.ghostwriters.map((g) => <SelectItem key={g.slug} value={g.slug}>{g.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" className="ml-auto" onClick={props.onRegenerate} disabled={props.loading}>
            <Sparkles className="mr-1 h-3.5 w-3.5" />{hasText ? t("pipeline.regenerate") : t("pipeline.generate")}
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {props.loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("pipeline.generating")}</div>
          ) : hasText ? (
            <AutoTextarea value={props.text} onChange={(e) => props.onChange(e.target.value)} className="text-sm leading-7" minRows={12} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
              <p className="max-w-sm text-sm text-muted-foreground">{t("pipeline.generateHint")}</p>
              <Button size="lg" onClick={props.onRegenerate}>
                <Sparkles className="mr-2 h-4 w-4" />{t("pipeline.generate")}
              </Button>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={props.onCancel}>{t("common.cancel")}</Button>
          <Button onClick={props.onConfirm} disabled={props.loading || !hasText}>{t("pipeline.apply")}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
