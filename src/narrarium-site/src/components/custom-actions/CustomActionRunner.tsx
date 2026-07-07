import { useEffect, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { Copy, Loader2, Volume2, VolumeX } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { FileDiff } from "@/components/diff/DiffView";
import { useToast } from "@/components/ui/use-toast";
import { runCustomAction } from "@/custom-actions/customActions";
import { speakText, type SpeechController } from "@/assistant/speech";
import { useBooksStore } from "@/store/booksStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { CustomAction } from "@/types/settings";

export interface CustomActionInvocation {
  id: string;
  action: CustomAction;
  selection: string;
  editable: HTMLTextAreaElement | HTMLInputElement | null;
  range: { start: number; end: number } | null;
}

function splitEdges(text: string): { lead: string; trail: string } {
  const lead = text.match(/^\s*/)?.[0] ?? "";
  const trail = text.match(/\s*$/)?.[0] ?? "";
  return { lead, trail };
}

function setNativeValue(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

export function CustomActionRunner({ invocation, onDone }: { invocation: CustomActionInvocation | null; onDone: () => void }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const location = useLocation();
  const pathname = location.pathname;
  const { settings } = useSettingsStore();
  const { structures, workingBranches } = useBooksStore();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const speechRef = useRef<SpeechController | null>(null);

  const action = invocation?.action ?? null;
  const previous = invocation
    ? invocation.action.activation === "selection" && invocation.selection.trim()
      ? invocation.selection
      : invocation.editable?.value ?? ""
    : "";

  useEffect(() => {
    if (!invocation) return;
    let cancelled = false;
    setLoading(true);
    setResult("");
    setError("");
    void runCustomAction({
      action: invocation.action,
      pathname,
      settings,
      books: settings.books,
      structures,
      workingBranches,
      selection: invocation.selection,
      editorBody: invocation.editable?.value,
    })
      .then((text) => { if (!cancelled) setResult(text); })
      .catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [invocation, pathname, settings, structures, workingBranches]);

  useEffect(() => () => {
    speechRef.current?.stop();
    speechRef.current = null;
  }, []);

  function close() {
    stopSpeech();
    setResult("");
    setError("");
    onDone();
  }

  async function copyResult() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      toast({ title: t("customActions.copied") });
    } catch (err) {
      toast({ title: t("customActions.copyFailed"), description: String(err), variant: "destructive" });
    }
  }

  function stopSpeech() {
    speechRef.current?.stop();
    speechRef.current = null;
    setSpeaking(false);
  }

  async function toggleSpeech() {
    if (speechRef.current) {
      stopSpeech();
      return;
    }
    if (!result.trim()) return;
    setSpeaking(true);
    try {
      const controller = await speakText(result, settings);
      speechRef.current = controller;
      await controller.done;
    } catch (err) {
      toast({ title: t("shell.ttsFailed"), description: String(err), variant: "destructive" });
    } finally {
      speechRef.current = null;
      setSpeaking(false);
    }
  }

  function applyReplacement() {
    if (!invocation || !action || !result) return;
    const el = invocation.editable;
    if (!el) {
      toast({ title: t("customActions.replaceNeedsEditor") });
      return;
    }
    const current = el.value;
    if (action.activation === "selection" && invocation.range) {
      const selected = current.slice(invocation.range.start, invocation.range.end);
      const { lead, trail } = splitEdges(selected);
      const next = current.slice(0, invocation.range.start) + lead + result + trail + current.slice(invocation.range.end);
      setNativeValue(el, next);
      requestAnimationFrame(() => {
        el.focus();
        const caret = invocation.range!.start + lead.length + result.length;
        el.setSelectionRange(caret, caret);
      });
    } else {
      setNativeValue(el, result);
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(0, result.length);
      });
    }
    toast({ title: t("customActions.replaced") });
    close();
  }

  return (
    <Dialog open={Boolean(invocation)} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="left-1/2 top-1/2 flex h-[88dvh] max-h-[88dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col p-0 sm:w-[880px]">
        <div className="border-b px-4 py-3">
          <p className="font-semibold">{action?.name || t("customActions.title")}</p>
          {action && <p className="mt-1 text-xs text-muted-foreground">{action.outputMode === "replace" ? t("customActions.replacePreview") : t("customActions.result")}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("pipeline.generating")}</div>
          ) : error ? (
            <pre className="whitespace-pre-wrap rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</pre>
          ) : action?.outputMode === "replace" ? (
            <FileDiff previous={previous} next={result} />
          ) : (
            <pre className="min-h-full whitespace-pre-wrap rounded-lg border bg-muted/20 p-3 text-sm leading-6">{result}</pre>
          )}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t px-4 py-3">
          <Button variant="ghost" onClick={close}>{t("common.close")}</Button>
          <Button variant="outline" onClick={() => void copyResult()} disabled={loading || !result.trim()}><Copy className="mr-1 h-4 w-4" />{t("customActions.copy")}</Button>
          <Button variant="outline" onClick={() => void toggleSpeech()} disabled={loading || !result.trim()}>{speaking ? <VolumeX className="mr-1 h-4 w-4" /> : <Volume2 className="mr-1 h-4 w-4" />}{speaking ? t("customActions.stopReading") : t("customActions.read")}</Button>
          {action?.outputMode === "replace" && <Button onClick={applyReplacement} disabled={loading || !result}>{t("customActions.confirmReplace")}</Button>}
        </div>
      </DialogContent>
    </Dialog>
  );
}
