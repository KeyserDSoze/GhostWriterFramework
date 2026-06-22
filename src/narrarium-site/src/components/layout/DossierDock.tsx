import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useDossierStore } from "@/store/dossierStore";

export function DossierDock() {
  const { t } = useTranslation();
  const { dossiers, closeDossier } = useDossierStore();

  if (dossiers.length === 0) return null;

  return (
    <aside className="hidden w-96 shrink-0 border-l bg-card/92 xl:flex xl:flex-col">
      <div className="border-b p-4">
        <p className="text-xs uppercase tracking-[0.22em] text-primary">{t("dossier.pinned")}</p>
        <p className="mt-1 text-sm text-muted-foreground">Canon context stays open while you edit.</p>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 p-4">
          {dossiers.map((dossier) => (
            <article key={dossier.id} className="rounded-2xl border bg-background/70 p-4 shadow-sm">
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <p className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground">{dossier.section}</p>
                  <h3 className="font-serif text-xl font-semibold leading-tight">{dossier.title}</h3>
                </div>
                <Button variant="ghost" size="icon" onClick={() => closeDossier(dossier.id)} aria-label={t("dossier.close")}>
                  <X className="h-4 w-4" />
                </Button>
              </div>
              <p className="mb-3 break-all rounded-lg bg-muted px-2 py-1 font-mono text-[10px] text-muted-foreground">
                {dossier.path}
              </p>
              <pre className="max-h-[420px] whitespace-pre-wrap rounded-xl bg-muted/50 p-3 text-xs leading-5 text-foreground">
                {dossier.content}
              </pre>
            </article>
          ))}
        </div>
      </ScrollArea>
    </aside>
  );
}
