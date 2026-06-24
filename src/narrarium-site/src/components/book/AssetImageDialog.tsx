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
}) {
  const { book, branch, token, kind, title, chapterSlug, paragraphSlug, textPath, resumePath } = props;
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<AssetPromptSource>(resumePath ? "resume" : textPath ? "text" : "custom");
  const [prompt, setPrompt] = useState(defaultPrompt(kind, title, ""));
  const [altText, setAltText] = useState("");
  const [caption, setCaption] = useState("");
  const [orientation, setOrientation] = useState<AssetOrientation>(kind === "book" ? "portrait" : "portrait");
  const [aspectRatio, setAspectRatio] = useState(kind === "book" ? "2:3" : "2:3");
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [existingImagePath, setExistingImagePath] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    let objectUrl: string | null = null;
    const target = buildAssetTarget({ kind, chapterSlug, paragraphSlug });
    setExistingImagePath(null);
    setPreviewUrl(null);
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
      const generated = await generateAssetImage({ settings, prompt, orientation });
      const target = await savePrompt(generated.provider, generated.model, "png");
      await saveAssetImage({ token, owner: book.owner, repo: book.repo, branch, path: target.imagePath, bytes: generated.bytes });
      setExistingImagePath(target.imagePath);
      setPreviewUrl(URL.createObjectURL(new Blob([bytesToArrayBuffer(generated.bytes)], { type: "image/png" })));
      toast({ title: t("images.imageGenerated") });
    } catch (err) {
      toast({ title: t("images.generationFailed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Image className="mr-1 h-4 w-4" />
          {t("images.title")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("images.titleFor", { title })}</DialogTitle>
        </DialogHeader>
          <div className="grid gap-4">
          {previewUrl && (
            <div className="rounded-xl border bg-muted/20 p-3">
              <p className="mb-2 text-xs text-muted-foreground">{existingImagePath ?? t("images.preview")}</p>
              <img src={previewUrl} alt={altText || title} className="max-h-80 w-full rounded-lg object-contain" />
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
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
          <Button variant="outline" onClick={() => void handleSavePrompt()} disabled={busy || !prompt.trim()}>{t("images.savePrompt")}</Button>
          <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={busy || !prompt.trim()}><Upload className="mr-1 h-4 w-4" />{t("images.uploadImage")}</Button>
          <Button onClick={() => void handleGenerate()} disabled={busy || !prompt.trim()}>{busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}{t("images.generateImage")}</Button>
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
