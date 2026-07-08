import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, BookOpen, Loader2, Save, Trash2 } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { useSettings } from "@/drive/useSettings";
import { useRegisterPageSave } from "@/store/saveStore";
import { useSettingsStore } from "@/store/settingsStore";
import type { ReaderLineBreakMode, ReaderSettings } from "@/types/settings";

export function ReaderSettingsPage() {
  const { t } = useTranslation();
  const location = useLocation();
  const { toast } = useToast();
  const { settings, patchSettings } = useSettingsStore();
  const { save, load, syncStatus } = useSettings();
  const didLoad = useRef(false);
  const [savedSnapshot, setSavedSnapshot] = useState(() => JSON.stringify(settings.reader));
  const reader = settings.reader;
  const readerReturnTo = getReaderReturnTo(location.state);
  const dirty = JSON.stringify(reader) !== savedSnapshot;
  const saving = syncStatus === "saving";

  useEffect(() => {
    if (didLoad.current) return;
    didLoad.current = true;
    void load().then(() => setSavedSnapshot(JSON.stringify(useSettingsStore.getState().settings.reader)));
  }, [load]);

  useRegisterPageSave({ dirty, enabled: true, onSave: () => handleSave() });

  function patchReader(patch: Partial<ReaderSettings>) {
    patchSettings({ reader: { ...reader, ...patch } });
  }

  function deleteBookmark(id: string) {
    patchReader({ bookmarks: reader.bookmarks.filter((entry) => entry.id !== id) });
  }

  async function handleSave() {
    await save();
    setSavedSnapshot(JSON.stringify(useSettingsStore.getState().settings.reader));
    toast({ title: t("reader.settingsSaved") });
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight"><BookOpen className="h-6 w-6" />{t("reader.settingsTitle")}</h1>
          <p className="text-muted-foreground">{t("reader.settingsDescription")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {readerReturnTo && <Button asChild variant="outline"><Link to={readerReturnTo}><ArrowLeft className="mr-1 h-4 w-4" />{t("reader.backToBook")}</Link></Button>}
          <Button onClick={() => void handleSave()} disabled={saving || !dirty}>{saving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}{t("common.save")}</Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("reader.display")}</CardTitle>
          <CardDescription>{t("reader.displayDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ReaderSwitch label={t("reader.showImages")} hint={t("reader.showImagesHint")} checked={reader.showImages} onChange={(showImages) => patchReader({ showImages })} />
          <ReaderSwitch label={t("reader.showFrontmatter")} hint={t("reader.showFrontmatterHint")} checked={reader.showFrontmatter} onChange={(showFrontmatter) => patchReader({ showFrontmatter })} />
          <ReaderSwitch label={t("reader.showEntityLinks")} hint={t("reader.showEntityLinksHint")} checked={reader.showRichEntityLinks} onChange={(showRichEntityLinks) => patchReader({ showRichEntityLinks })} />
          <ReaderSwitch label={t("reader.fullscreen")} hint={t("reader.fullscreenHint")} checked={reader.fullScreen} onChange={(fullScreen) => patchReader({ fullScreen })} />
          <div className="grid gap-2 sm:max-w-md">
            <Label>{t("reader.fontFamily")}</Label>
            <Select value={reader.fontFamily} onValueChange={(fontFamily) => patchReader({ fontFamily: fontFamily as ReaderSettings["fontFamily"] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="serif">{t("reader.fontSerif")}</SelectItem>
                <SelectItem value="sans">{t("reader.fontSans")}</SelectItem>
                <SelectItem value="mono">{t("reader.fontMono")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("reader.reading")}</CardTitle>
          <CardDescription>{t("reader.readingDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="grid gap-2 sm:col-span-3">
            <Label>{t("reader.lineBreakMode")}</Label>
            <Select value={reader.lineBreakMode} onValueChange={(lineBreakMode) => patchReader({ lineBreakMode: lineBreakMode as ReaderLineBreakMode })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="book">{t("reader.lineBreakBook")}</SelectItem>
                <SelectItem value="dialogue">{t("reader.lineBreakDialogue")}</SelectItem>
                <SelectItem value="source">{t("reader.lineBreakSource")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("reader.lineBreakHint")}</p>
          </div>
          <NumberSetting label={t("reader.fontSize")} value={reader.fontSize} min={14} max={32} step={1} suffix="px" onChange={(fontSize) => patchReader({ fontSize })} />
          <NumberSetting label={t("reader.lineHeight")} value={reader.lineHeight} min={1.2} max={2.4} step={0.05} onChange={(lineHeight) => patchReader({ lineHeight })} />
          <NumberSetting label={t("reader.pageMargin")} value={reader.pageMargin} min={16} max={96} step={4} suffix="px" onChange={(pageMargin) => patchReader({ pageMargin })} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("reader.bookmarks")}</CardTitle>
          <CardDescription>{t("reader.bookmarksSettingsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {reader.bookmarks.length === 0 ? (
            <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{t("reader.noBookmarks")}</p>
          ) : reader.bookmarks.map((bookmark) => {
            const book = settings.books.find((entry) => entry.id === bookmark.bookId);
            return (
              <div key={bookmark.id} className="flex items-start gap-3 rounded-xl border p-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{bookmark.label}</p>
                  <p className="text-xs text-muted-foreground">{book?.name ?? bookmark.bookId} · {bookmark.chapterSlug} · {bookmark.paragraphNumber}</p>
                  {bookmark.preview && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{bookmark.preview}</p>}
                </div>
                <Button variant="ghost" size="icon" onClick={() => deleteBookmark(bookmark.id)} aria-label={t("reader.deleteBookmark")}><Trash2 className="h-4 w-4 text-destructive" /></Button>
              </div>
            );
          })}
          <Separator />
          <p className="text-xs text-muted-foreground">{t("reader.bookmarkLogicHint")}</p>
        </CardContent>
      </Card>
    </div>
  );
}

function getReaderReturnTo(state: unknown): string | null {
  if (!state || typeof state !== "object") return null;
  const returnTo = (state as { returnTo?: unknown }).returnTo;
  if (typeof returnTo !== "string") return null;
  return /^\/app\/books\/[^/]+\/reader$/.test(returnTo) ? returnTo : null;
}

function ReaderSwitch({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

function NumberSetting({ label, value, min, max, step, suffix, onChange }: { label: string; value: number; min: number; max: number; step: number; suffix?: string; onChange: (value: number) => void }) {
  return (
    <div className="grid gap-2">
      <Label>{label}</Label>
      <div className="flex items-center gap-2">
        <Input type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(clampNumber(Number(event.target.value), min, max, value))} />
        {suffix && <span className="text-sm text-muted-foreground">{suffix}</span>}
      </div>
    </div>
  );
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}
