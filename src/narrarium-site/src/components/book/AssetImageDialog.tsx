import { useEffect, useRef, useState } from "react";
import { Image, Loader2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BookEntry } from "@/types/settings";
import type { AssetOrientation, AssetPromptSource, AssetSubjectKind } from "@/assets/assetImages";
import { buildAssetTarget, composeAssetPromptWithAI, generateAssetImage, loadExistingAssetImage, renderAssetMarkdown, saveAssetImage, saveAssetMarkdown } from "@/assets/assetImages";
import { loadFileContent } from "@/github/githubClient";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";

export function AssetImageDialog(props: {
  book: BookEntry;
  branch: string;
  token: string;
  kind: AssetSubjectKind;
  title: string;
  chapterSlug?: string;
  paragraphSlug?: string;
  textPath?: string;
  resumePath?: string;
  /** Controlled open state. When provided the dialog is controlled and the default trigger is hidden. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const { book, branch, token, kind, title, chapterSlug, paragraphSlug, textPath, resumePath } = props;
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const controlled = props.open !== undefined;
  const open = controlled ? props.open! : internalOpen;
  const setOpen = (next: boolean) => { if (controlled) props.onOpenChange?.(next); else setInternalOpen(next); };
  const hideTrigger = props.hideTrigger ?? controlled;
  const [source, setSource] = useState<AssetPromptSource>(resumePath ? "resume" : textPath ? "text" : "custom");
  const [prompt, setPrompt] = useState(defaultPrompt(kind, title, ""));
  const [altText, setAltText] = useState("");
  const [caption, setCaption] = useState("");
  const [orientation, setOrientation] = useState<AssetOrientation>(kind === "book" ? "portrait" : "portrait");
  const [aspectRatio, setAspectRatio] = useState(kind === "book" ? "2:3" : "2:3");
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [existingImagePath, setExistingImagePath] = useState<string | null>(null);
  const [pendingGenerated, setPendingGenerated] = useState<{ bytes: Uint8Array; url: string; provider: string; model: string; cost?: number } | null>(null);

  function clearPendingGenerated() {
    setPendingGenerated((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return null;
    });
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    let objectUrl: string | null = null;
    const target = buildAssetTarget({ kind, chapterSlug, paragraphSlug });
    setExistingImagePath(null);
    setPreviewUrl(null);
    clearPendingGenerated();
    void loadExistingAssetImage({ token, owner: book.owner, repo: book.repo, branch, target })
      .then((asset) => {
        if (!active || !asset) return;
        if (asset.prompt) setPrompt(asset.prompt);
        setAltText(asset.altText);
        setCaption(asset.caption);
        setOrientation(asset.orientation);
        setAspectRatio(asset.aspectRatio);
        setExistingImagePath(asset.imagePath ?? null);
        if (asset.imageBytes && asset.mimeType) {
          objectUrl = URL.createObjectURL(new Blob([bytesToArrayBuffer(asset.imageBytes)], { type: asset.mimeType }));
          setPreviewUrl(objectUrl);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [book.owner, book.repo, branch, chapterSlug, kind, open, paragraphSlug, token]);

  useEffect(() => () => clearPendingGenerated(), []);

  async function loadSourceText(): Promise<string> {
    const path = source === "resume" ? resumePath : source === "text" ? textPath : undefined;
    if (!path) return "";
    return loadFileContent(token, book.owner, book.repo, path, branch).catch(() => "");
  }

  async function composePrompt() {
    setBusy(true);
    try {
      const sourceText = await loadSourceText();
      const aiPrompt = await composeAssetPromptWithAI({ settings, kind, title, sourceText }).catch(() => null);
      setPrompt(aiPrompt ?? defaultPrompt(kind, title, sourceText));
    } finally {
      setBusy(false);
    }
  }

  async function savePrompt(provider?: string, model?: string, extension = "png") {
    const target = buildAssetTarget({ kind, chapterSlug, paragraphSlug, extension });
    await saveAssetMarkdown({
      token,
      owner: book.owner,
      repo: book.repo,
      branch,
      path: target.markdownPath,
      content: renderAssetMarkdown({
        target,
        prompt,
        orientation,
        aspectRatio,
        altText,
        caption,
        provider,
        model,
      }),
    });
    return target;
  }

  async function handleSavePrompt() {
    setBusy(true);
    try {
      await savePrompt();
      toast({ title: t("images.promptSaved") });
    } catch (err) {
      toast({ title: t("images.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function handleUpload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      clearPendingGenerated();
      const extension = file.name.split(".").pop()?.toLowerCase() || "png";
      const target = await savePrompt(undefined, undefined, extension);
      await saveAssetImage({
        token,
        owner: book.owner,
        repo: book.repo,
        branch,
        path: target.imagePath,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      setExistingImagePath(target.imagePath);
      setPreviewUrl(URL.createObjectURL(file));
      toast({ title: t("images.imageSaved") });
    } catch (err) {
      toast({ title: t("images.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleGenerate() {
    setBusy(true);
    try {
      clearPendingGenerated();
      const generated = await generateAssetImage({ settings, prompt, orientation });
      const url = URL.createObjectURL(new Blob([bytesToArrayBuffer(generated.bytes)], { type: "image/png" }));
      if (previewUrl) {
        setPendingGenerated({ ...generated, url });
        toast({ title: t("images.imageGeneratedCompare") });
      } else {
        await saveGeneratedImage({ ...generated, url });
        toast({ title: t("images.imageGenerated") });
      }
    } catch (err) {
      toast({ title: t("images.generationFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  async function saveGeneratedImage(generated: { bytes: Uint8Array; url: string; provider: string; model: string; cost?: number }) {
    const target = await savePrompt(generated.provider, generated.model, "png");
    await saveAssetImage({ token, owner: book.owner, repo: book.repo, branch, path: target.imagePath, bytes: generated.bytes });
    setExistingImagePath(target.imagePath);
    setPreviewUrl((current) => {
      if (current && current.startsWith("blob:")) URL.revokeObjectURL(current);
      return generated.url;
    });
    setPendingGenerated(null);
  }

  async function keepGeneratedImage() {
    if (!pendingGenerated) return;
    setBusy(true);
    try {
      await saveGeneratedImage(pendingGenerated);
      toast({ title: t("images.imageGenerated") });
    } catch (err) {
      toast({ title: t("images.saveFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  function keepCurrentImage() {
    clearPendingGenerated();
    toast({ title: t("images.keptCurrent") });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Image className="mr-1 h-4 w-4" />
            {t("images.title")}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="flex max-h-[92dvh] w-[96vw] max-w-5xl flex-col overflow-hidden p-0">
        <DialogHeader className="shrink-0 px-4 pt-4 sm:px-6 sm:pt-6">
          <DialogTitle>{t("images.titleFor", { title })}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="grid gap-4">
          {pendingGenerated && previewUrl ? (
            <div className="rounded-xl border bg-muted/20 p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{t("images.compareTitle")}</p>
                  <p className="text-xs text-muted-foreground">{t("images.generationCost", { cost: formatCost(pendingGenerated.cost) })}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={keepCurrentImage} disabled={busy}>{t("images.keepCurrent")}</Button>
                  <Button type="button" size="sm" onClick={() => void keepGeneratedImage()} disabled={busy}>{busy ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}{t("images.keepGenerated")}</Button>
                </div>
              </div>
              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-lg border bg-background p-2">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">{t("images.currentImage")}</p>
                  <img src={previewUrl} alt={altText || title} className="max-h-[48vh] w-full rounded-md object-contain lg:max-h-80" />
                </div>
                <div className="rounded-lg border border-primary/40 bg-background p-2">
                  <p className="mb-2 text-xs font-medium text-muted-foreground">{t("images.newImage")}</p>
                  <img src={pendingGenerated.url} alt={altText || title} className="max-h-[48vh] w-full rounded-md object-contain lg:max-h-80" />
                </div>
              </div>
            </div>
          ) : previewUrl && (
            <div className="rounded-xl border bg-muted/20 p-3">
              <p className="mb-2 text-xs text-muted-foreground">{existingImagePath ?? t("images.preview")}</p>
              <img src={previewUrl} alt={altText || title} className="max-h-[50vh] w-full rounded-lg object-contain sm:max-h-80" />
            </div>
          )}
          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <div className="grid gap-2">
              <Label>{t("images.promptSource")}</Label>
              <Select value={source} onValueChange={(value) => setSource(value as AssetPromptSource)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="custom">{t("images.sourceCustom")}</SelectItem>
                  <SelectItem value="text" disabled={!textPath}>{t("images.sourceText")}</SelectItem>
                  <SelectItem value="resume" disabled={!resumePath}>{t("images.sourceResume")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end">
              <Button type="button" variant="outline" onClick={() => void composePrompt()} disabled={busy || source === "custom"}>{t("images.composePrompt")}</Button>
            </div>
          </div>
          <div className="grid gap-2">
            <Label>{t("images.prompt")}</Label>
            <Textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={8} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>{t("images.altText")}</Label>
              <Input value={altText} onChange={(event) => setAltText(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>{t("images.caption")}</Label>
              <Input value={caption} onChange={(event) => setCaption(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label>{t("images.orientation")}</Label>
              <Select value={orientation} onValueChange={(value) => setOrientation(value as AssetOrientation)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="portrait">{t("images.portrait")}</SelectItem>
                  <SelectItem value="landscape">{t("images.landscape")}</SelectItem>
                  <SelectItem value="square">{t("images.square")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("images.aspectRatio")}</Label>
              <Input value={aspectRatio} onChange={(event) => setAspectRatio(event.target.value)} />
            </div>
          </div>
          <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(event) => void handleUpload(event.target.files?.[0])} />
        </div>
        </div>
        <DialogFooter className="shrink-0 gap-2 border-t bg-background px-4 py-3 sm:flex-wrap sm:px-6">
          <Button className="w-full sm:w-auto" variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
          <Button className="w-full sm:w-auto" variant="outline" onClick={() => void handleSavePrompt()} disabled={busy || !prompt.trim()}>{t("images.savePrompt")}</Button>
          <Button className="w-full sm:w-auto" variant="outline" onClick={() => fileInputRef.current?.click()} disabled={busy || !prompt.trim()}><Upload className="mr-1 h-4 w-4" />{t("images.uploadImage")}</Button>
          <Button className="w-full sm:w-auto" onClick={() => void handleGenerate()} disabled={busy || !prompt.trim()}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{t("images.generateImage")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function defaultPrompt(kind: AssetSubjectKind, title: string, sourceText: string): string {
  const clipped = sourceText.replace(/^---[\s\S]*?---\s*/, "").replace(/\s+/g, " ").trim().slice(0, 1400);
  if (kind === "book") {
    return `# Prompt\n\n${title}, cover illustration, main emotional image of the book, portrait orientation, 2:3 ratio, leave clean space for title typography, consistent with the book visual language.${clipped ? `\n\nSource context: ${clipped}` : ""}`;
  }
  if (kind === "chapter") {
    return `# Prompt\n\nChapter-opening illustration for ${title}, showing the core dramatic image, location, mood, portrait orientation, 2:3 ratio, cinematic composition, visually aligned with the rest of the book.${clipped ? `\n\nSource context: ${clipped}` : ""}`;
  }
  return `# Prompt\n\nScene illustration for ${title}, characters present, action, location, emotional beat, portrait orientation, 2:3 ratio, preserve continuity with existing character and location assets.${clipped ? `\n\nSource context: ${clipped}` : ""}`;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function formatCost(cost: number | undefined): string {
  if (typeof cost !== "number" || !Number.isFinite(cost)) return "n/d";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 4 }).format(cost);
}
