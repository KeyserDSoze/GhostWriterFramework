import { useEffect, useState } from "react";
import { FolderOpen, Loader2, Save, Settings, Trash2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { useAuthStore } from "@/store/authStore";
import {
  resolveBookExportProfiles,
  resolveBookExportSettings,
  type BookEntry,
  type BookExportProfile,
  type BookExportSettings,
} from "@/types/settings";
import { GoogleDriveFolderDialog } from "@/components/book/GoogleDriveFolderDialog";
import { OneDriveFolderDialog } from "@/components/book/OneDriveFolderDialog";
import type { DriveFolderEntry } from "@/drive/exportDriveClient";

interface BookExportSettingsDialogProps {
  bookId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function BookExportSettingsDialog({ bookId, open, onOpenChange }: BookExportSettingsDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings, patchSettings } = useSettingsStore();
  const { save, syncStatus } = useSettings();
  const { user, accessToken } = useAuthStore();

  const book = settings.books.find((entry) => entry.id === bookId);
  const fallbackBook: BookEntry = book ?? { id: "", owner: "", repo: "", name: "", tokenIndex: null, addedAt: "" };

  // ── local state (reset on open) ────────────────────────────────────────
  const [exportProfiles, setExportProfiles] = useState<BookExportProfile[]>(() => resolveBookExportProfiles(fallbackBook));
  const [selectedExportProfileId, setSelectedExportProfileId] = useState(() => book?.defaultExportProfileId ?? resolveBookExportProfiles(fallbackBook)[0]?.id ?? "default");
  const [newPresetName, setNewPresetName] = useState("");
  const [exportSettings, setExportSettings] = useState<BookExportSettings>(() => resolveBookExportSettings(fallbackBook));
  const [googleFolderDialogOpen, setGoogleFolderDialogOpen] = useState(false);
  const [oneDriveFolderDialogOpen, setOneDriveFolderDialogOpen] = useState(false);

  // Sync state whenever dialog opens or the book entry changes externally
  useEffect(() => {
    if (!open || !book) return;
    const profiles = resolveBookExportProfiles(book);
    const selectedId = book.defaultExportProfileId ?? profiles[0]?.id ?? "default";
    setExportProfiles(profiles);
    setSelectedExportProfileId(selectedId);
    setExportSettings(resolveBookExportSettings(book, selectedId));
    setNewPresetName("");
  }, [open, book?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // When selected profile changes, reload export settings for that profile
  useEffect(() => {
    if (!book) return;
    const selected = exportProfiles.find((profile) => profile.id === selectedExportProfileId) ?? exportProfiles[0];
    if (!selected) return;
    setExportSettings(resolveBookExportSettings({ ...book, exportProfiles }, selected.id));
  }, [selectedExportProfileId]); // eslint-disable-line react-hooks/exhaustive-deps

  function patchExportSettings(patch: Partial<BookExportSettings>) {
    setExportSettings((current) => {
      const next = { ...current, ...patch };
      setExportProfiles((profiles) =>
        profiles.map((profile) =>
          profile.id === selectedExportProfileId ? { ...profile, settings: next } : profile,
        ),
      );
      return next;
    });
  }

  function addExportPreset() {
    const name = newPresetName.trim();
    if (!name) return;
    const preset: BookExportProfile = { id: crypto.randomUUID(), name, settings: { ...exportSettings } };
    setExportProfiles((current) => [...current, preset]);
    setSelectedExportProfileId(preset.id);
    setNewPresetName("");
  }

  function removeCurrentExportPreset() {
    if (exportProfiles.length <= 1) return;
    const remaining = exportProfiles.filter((profile) => profile.id !== selectedExportProfileId);
    const nextSelected = remaining[0]?.id ?? "default";
    setExportProfiles(remaining);
    setSelectedExportProfileId(nextSelected);
    setExportSettings(resolveBookExportSettings({ ...fallbackBook, exportProfiles: remaining, defaultExportProfileId: nextSelected }, nextSelected));
  }

  async function handleSave() {
    if (!book) return;
    const updated: BookEntry = {
      ...book,
      exportSettings,
      exportProfiles,
      defaultExportProfileId: selectedExportProfileId,
    };
    patchSettings({ books: settings.books.map((entry) => (entry.id === book.id ? updated : entry)) });
    await save();
    toast({ title: t("export.settingsSaved") });
    onOpenChange(false);
  }

  const isSaving = syncStatus === "saving";

  if (!book) return null;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="left-1/2 top-1/2 flex h-[90dvh] max-h-[90dvh] w-[96vw] max-w-none -translate-x-1/2 -translate-y-1/2 flex-col p-0 sm:w-[680px]">
          <DialogHeader className="flex-shrink-0 border-b px-6 py-4">
            <DialogTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5 text-primary" />
              {t("export.settingsTitle")}
            </DialogTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">{t("export.settingsDescription")}</p>
          </DialogHeader>

          <ScrollArea className="min-h-0 flex-1">
            <div className="space-y-6 px-6 py-5">

              {/* ── Preset management ── */}
              <div className="space-y-3">
                <p className="text-sm font-semibold">{t("export.presetManagement")}</p>
                <div className="grid gap-3 rounded-lg border border-dashed p-4">
                  <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
                    <div className="grid gap-2">
                      <Label>{t("export.preset")}</Label>
                      <Select value={selectedExportProfileId} onValueChange={setSelectedExportProfileId}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {exportProfiles.map((profile) => (
                            <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="grid gap-2">
                      <Label>{t("export.presetName")}</Label>
                      <Input
                        value={exportProfiles.find((profile) => profile.id === selectedExportProfileId)?.name ?? ""}
                        onChange={(e) => setExportProfiles((current) =>
                          current.map((profile) =>
                            profile.id === selectedExportProfileId ? { ...profile, name: e.target.value } : profile,
                          ),
                        )}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-end gap-2">
                    <div className="grid flex-1 gap-1.5">
                      <Label className="text-xs text-muted-foreground">{t("export.newPresetPlaceholder")}</Label>
                      <Input
                        placeholder={t("export.newPresetPlaceholder")}
                        value={newPresetName}
                        onChange={(e) => setNewPresetName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Enter") addExportPreset(); }}
                      />
                    </div>
                    <Button type="button" variant="outline" size="sm" onClick={addExportPreset} disabled={!newPresetName.trim()}>
                      <Plus className="mr-1 h-3.5 w-3.5" />{t("export.addPreset")}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={removeCurrentExportPreset} disabled={exportProfiles.length <= 1}>
                      <Trash2 className="mr-1 h-3.5 w-3.5" />{t("export.removePreset")}
                    </Button>
                  </div>
                </div>
              </div>

              <Separator />

              {/* ── Scope & structure ── */}
              <div className="space-y-3">
                <p className="text-sm font-semibold">{t("export.scopeSection")}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label>{t("export.defaultScope")}</Label>
                    <Select value={exportSettings.defaultScope} onValueChange={(value) => patchExportSettings({ defaultScope: value as "full" | "draft" })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="draft">{t("export.publisherDraft", { count: exportSettings.sampleChapters })}</SelectItem>
                        <SelectItem value="full">{t("export.fullBook")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>{t("export.sampleChapters")}</Label>
                    <Input type="number" min="1" value={exportSettings.sampleChapters} onChange={(e) => patchExportSettings({ sampleChapters: Math.max(1, Number(e.target.value) || 1) })} />
                  </div>
                </div>
              </div>

              <Separator />

              {/* ── Typography ── */}
              <div className="space-y-3">
                <p className="text-sm font-semibold">{t("export.typographySection")}</p>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="grid gap-2">
                    <Label>{t("export.fontFamily")}</Label>
                    <Select value={exportSettings.fontFamily} onValueChange={(value) => patchExportSettings({ fontFamily: value as "serif" | "sans" | "mono" })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="serif">{t("reader.fontSerif")}</SelectItem>
                        <SelectItem value="sans">{t("reader.fontSans")}</SelectItem>
                        <SelectItem value="mono">{t("reader.fontMono")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>{t("export.fontName")}</Label>
                    <Input value={exportSettings.fontName} onChange={(e) => patchExportSettings({ fontName: e.target.value })} />
                  </div>
                  <div className="grid gap-2">
                    <Label>{t("export.fontSize")}</Label>
                    <Input type="number" min="8" max="18" value={exportSettings.fontSize} onChange={(e) => patchExportSettings({ fontSize: Math.max(8, Number(e.target.value) || 12) })} />
                  </div>
                  <div className="grid gap-2">
                    <Label>{t("export.lineSpacing")}</Label>
                    <Input type="number" min="1" max="3" step="0.1" value={exportSettings.lineSpacing} onChange={(e) => patchExportSettings({ lineSpacing: Number(e.target.value) || 2 })} />
                  </div>
                  <div className="grid gap-2">
                    <Label>{t("export.marginInches")}</Label>
                    <Input type="number" min="0.5" max="2" step="0.1" value={exportSettings.marginInches} onChange={(e) => patchExportSettings({ marginInches: Number(e.target.value) || 1 })} />
                  </div>
                  <div className="grid gap-2">
                    <Label>{t("export.indentInches")}</Label>
                    <Input type="number" min="0" max="1" step="0.1" value={exportSettings.paragraphIndentInches} onChange={(e) => patchExportSettings({ paragraphIndentInches: Math.max(0, Number(e.target.value) || 0) })} />
                  </div>
                  <div className="grid gap-2">
                    <Label>{t("export.pageSize")}</Label>
                    <Select value={exportSettings.pageSize} onValueChange={(value) => patchExportSettings({ pageSize: value as "letter" | "a4" })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="letter">Letter</SelectItem>
                        <SelectItem value="a4">A4</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>{t("export.alignment")}</Label>
                    <Select value={exportSettings.paragraphAlignment} onValueChange={(value) => patchExportSettings({ paragraphAlignment: value as "left" | "justified" })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="left">{t("export.alignLeft")}</SelectItem>
                        <SelectItem value="justified">{t("export.alignJustified")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2 sm:col-span-2">
                    <Label>{t("export.lineBreakMode")}</Label>
                    <Select value={exportSettings.lineBreakMode} onValueChange={(value) => patchExportSettings({ lineBreakMode: value as "book" | "dialogue" | "source" })}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="book">{t("reader.lineBreakBook")}</SelectItem>
                        <SelectItem value="dialogue">{t("reader.lineBreakDialogue")}</SelectItem>
                        <SelectItem value="source">{t("reader.lineBreakSource")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">{t("reader.lineBreakHint")}</p>
                  </div>
                  <div className="grid gap-2 sm:col-span-2">
                    <Label>{t("export.sceneBreak")}</Label>
                    <Input value={exportSettings.sceneBreak} onChange={(e) => patchExportSettings({ sceneBreak: e.target.value || "#" })} />
                  </div>
                </div>
              </div>

              <Separator />

              {/* ── Content toggles ── */}
              <div className="space-y-3">
                <p className="text-sm font-semibold">{t("export.contentSection")}</p>
                <div className="grid gap-3 rounded-lg border border-dashed p-4">
                  {[
                    { key: "includeTitlePage", hint: "includeTitlePageHint", value: exportSettings.includeTitlePage, onChange: (checked: boolean) => patchExportSettings({ includeTitlePage: checked }) },
                    { key: "includeImages", hint: "includeImagesHint", value: exportSettings.includeImages, onChange: (checked: boolean) => patchExportSettings({ includeImages: checked }) },
                    { key: "includeFrontmatter", hint: "includeFrontmatterHint", value: exportSettings.includeFrontmatter, onChange: (checked: boolean) => patchExportSettings({ includeFrontmatter: checked }) },
                    { key: "showParagraphTitles", hint: "showParagraphTitlesHint", value: exportSettings.showParagraphTitles, onChange: (checked: boolean) => patchExportSettings({ showParagraphTitles: checked }) },
                    { key: "showChapterSummary", hint: "showChapterSummaryHint", value: exportSettings.showChapterSummary, onChange: (checked: boolean) => patchExportSettings({ showChapterSummary: checked }) },
                  ].map((row) => (
                    <div key={row.key} className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-sm">{t(`export.${row.key}`)}</p>
                        <p className="text-xs text-muted-foreground">{t(`export.${row.hint}`)}</p>
                      </div>
                      <Switch checked={row.value} onCheckedChange={row.onChange} />
                    </div>
                  ))}
                </div>
              </div>

              {/* ── Drive destination ── */}
              {(user?.provider === "google" || user?.provider === "microsoft") && (
                <>
                  <Separator />
                  <div className="space-y-3">
                    <p className="text-sm font-semibold">{t("export.driveDestination")}</p>
                    {user?.provider === "google" ? (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
                        <div>
                          <p className="text-xs text-muted-foreground">{t("export.googleFolder")}</p>
                          <p className="font-medium">{exportSettings.googleDriveFolderName ?? t("export.noFolderSelected")}</p>
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => setGoogleFolderDialogOpen(true)} disabled={!accessToken}>
                          <FolderOpen className="mr-1 h-4 w-4" />{t("export.chooseFolder")}
                        </Button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
                        <div>
                          <p className="text-xs text-muted-foreground">{t("export.microsoftFolderPath")}</p>
                          <p className="font-medium">{exportSettings.microsoftDriveFolderPath ?? t("export.noFolderSelected")}</p>
                        </div>
                        <Button type="button" variant="outline" size="sm" onClick={() => setOneDriveFolderDialogOpen(true)} disabled={!accessToken}>
                          <FolderOpen className="mr-1 h-4 w-4" />{t("export.chooseFolder")}
                        </Button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </ScrollArea>

          {/* ── Footer ── */}
          <div className="flex flex-shrink-0 items-center justify-end gap-2 border-t px-6 py-4">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => void handleSave()} disabled={isSaving}>
              {isSaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
              {t("settings.save")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {accessToken && (
        <GoogleDriveFolderDialog
          open={googleFolderDialogOpen}
          onOpenChange={setGoogleFolderDialogOpen}
          accessToken={accessToken}
          onSelect={(folder: DriveFolderEntry) => patchExportSettings({ googleDriveFolderId: folder.id, googleDriveFolderName: folder.name })}
        />
      )}
      {accessToken && (
        <OneDriveFolderDialog
          open={oneDriveFolderDialogOpen}
          onOpenChange={setOneDriveFolderDialogOpen}
          accessToken={accessToken}
          onSelect={(folderPath) => patchExportSettings({ microsoftDriveFolderPath: folderPath })}
        />
      )}
    </>
  );
}
