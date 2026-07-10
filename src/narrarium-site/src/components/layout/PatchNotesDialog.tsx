import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { APP_VERSION } from "@/config/version";
import { localizedPatchNote, ONBOARDING_COMPLETED_KEY, PATCH_NOTES_SEEN_KEY, patchNoteFor } from "@/content/patchNotes";

export function PatchNotesDialog() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const note = patchNoteFor(APP_VERSION);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (note && localStorage.getItem(ONBOARDING_COMPLETED_KEY) === "1" && localStorage.getItem(PATCH_NOTES_SEEN_KEY) !== APP_VERSION) setOpen(true);
  }, [note]);
  if (!note) return null;
  const localized = localizedPatchNote(note, i18n.language);
  const close = () => { localStorage.setItem(PATCH_NOTES_SEEN_KEY, APP_VERSION); setOpen(false); };
  return <Dialog open={open} onOpenChange={(next) => { if (!next) close(); else setOpen(true); }}><DialogContent className="max-h-[88dvh] overflow-auto sm:max-w-2xl"><DialogHeader><DialogTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 text-primary" />{t("patchNotes.whatsNew", { version: APP_VERSION })}</DialogTitle></DialogHeader><div><h2 className="text-lg font-semibold">{localized.title}</h2><p className="mt-1 text-sm text-muted-foreground">{localized.summary}</p><ul className="mt-4 space-y-2 text-sm leading-6">{localized.changes.map((change) => <li key={change} className="flex gap-3"><span className="text-primary">•</span><span>{change}</span></li>)}</ul></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={close}>{t("common.close")}</Button><Button onClick={() => { close(); navigate("/app/patch-notes"); }}>{t("patchNotes.viewAll")}</Button></div></DialogContent></Dialog>;
}
