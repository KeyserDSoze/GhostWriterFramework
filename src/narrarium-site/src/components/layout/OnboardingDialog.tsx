import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Bot, BookOpen, Check, ChevronLeft, ChevronRight, Github, Route, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ONBOARDING_COMPLETED_KEY } from "@/content/patchNotes";
import { useSettingsStore } from "@/store/settingsStore";

const STEP_ICONS = [Sparkles, Github, ShieldCheck, Bot, BookOpen, Route, Check];

export function OnboardingDialog() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const books = useSettingsStore((state) => state.settings.books);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  useEffect(() => {
    const manuallyOpen = () => { setStep(0); setOpen(true); };
    window.addEventListener("narrarium:open-onboarding", manuallyOpen);
    const timer = window.setTimeout(() => {
      if (localStorage.getItem(ONBOARDING_COMPLETED_KEY) !== "1" && books.length === 0) setOpen(true);
    }, 600);
    return () => { window.clearTimeout(timer); window.removeEventListener("narrarium:open-onboarding", manuallyOpen); };
  }, [books.length]);
  const Icon = STEP_ICONS[step];
  const total = STEP_ICONS.length;
  const finish = () => { localStorage.setItem(ONBOARDING_COMPLETED_KEY, "1"); setOpen(false); };
  const action = step === 1 ? () => window.open("https://github.com/signup", "_blank") : step === 2 ? () => window.open("https://github.com/settings/personal-access-tokens/new", "_blank") : step === 3 ? () => navigate("/app/settings/ai-router") : step === 4 ? () => navigate("/app/books/add") : undefined;
  return <Dialog open={open} onOpenChange={(next) => { if (!next) finish(); else setOpen(true); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{t("onboarding.title")}</DialogTitle></DialogHeader><div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${((step + 1) / total) * 100}%` }} /></div><div className="flex min-h-64 flex-col items-center justify-center px-4 text-center"><div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Icon className="h-8 w-8" /></div><p className="mt-5 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{t("onboarding.stepOf", { step: step + 1, total })}</p><h2 className="mt-2 font-serif text-2xl font-semibold">{t(`onboarding.steps.${step}.title`)}</h2><p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">{t(`onboarding.steps.${step}.body`)}</p>{action && <Button variant="outline" className="mt-5" onClick={action}>{t(`onboarding.steps.${step}.action`)}</Button>}</div><div className="flex items-center justify-between"><Button variant="ghost" onClick={finish}>{t("onboarding.skip")}</Button><div className="flex gap-2">{step > 0 && <Button variant="outline" onClick={() => setStep((value) => value - 1)}><ChevronLeft className="mr-1 h-4 w-4" />{t("common.back")}</Button>}{step < total - 1 ? <Button onClick={() => setStep((value) => value + 1)}>{t("onboarding.next")}<ChevronRight className="ml-1 h-4 w-4" /></Button> : <Button onClick={finish}>{t("onboarding.finish")}</Button>}</div></div></DialogContent></Dialog>;
}
