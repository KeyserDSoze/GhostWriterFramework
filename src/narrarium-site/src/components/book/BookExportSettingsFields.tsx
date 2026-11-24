import { useState } from "react";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { useAuthStore } from "@/store/authStore";
import type { BookEntry, BookExportSettings } from "@/types/settings";
import { GoogleDriveFolderDialog } from "@/components/book/GoogleDriveFolderDialog";
import { OneDriveFolderDialog } from "@/components/book/OneDriveFolderDialog";
import type { DriveFolderEntry } from "@/drive/exportDriveClient";
import { addExportPreset, patchExportSettings as patchExportDraft, removeExportPreset, renameExportPreset, selectExportPreset, type ExportDraft } from "@/bookSettings/exportDraft";

interface Props {
  draft: ExportDraft;
  onChange: (draft: ExportDraft) => void;
  /** The book, for the presets that are read from it, and the presentation that stays as it is being edited when another preset is selected. */
  book: BookEntry;
  keep?: Partial<BookExportSettings>;
}

/** The fields of the export presets: the presets, the scope, the typography, what the file holds and where it goes. The dialog of the export page and the Export tab of the settings show the same fields. */
export function BookExportSettingsFields({ draft, onChange, book, keep }: Props) {
  const { t } = useTranslation();
  const { user, accessToken } = useAuthStore();
  const { profiles: exportProfiles, selectedId: selectedExportProfileId, settings: exportSettings } = draft;
  const [newPresetName, setNewPresetName] = useState("");
  const [googleFolderDialogOpen, setGoogleFolderDialogOpen] = useState(false);
  const [oneDriveFolderDialogOpen, setOneDriveFolderDialogOpen] = useState(false);
  const patch = (change: Partial<BookExportSettings>) => onChange(patchExportDraft(draft, change));
  const selectPreset = (id: string) => onChange(selectExportPreset(draft, book, id, keep));
  const addPreset = () => { if (!newPresetName.trim()) return; onChange(addExportPreset(draft, newPresetName)); setNewPresetName(""); };
  const removePreset = () => onChange(removeExportPreset(draft, book, keep));

  return (
    <>
      <div className="space-y-6">
        {/* ── Preset management ── */}
        <div className="space-y-3">
          <p className="text-sm font-semibold">{t("export.presetManagement")}</p>
          <div className="grid gap-3 rounded-lg border border-dashed p-4">
            <div className="grid gap-3 sm:grid-cols-[1fr_1fr]">
              <div className="grid gap-2">
                <Label htmlFor="export-preset">{t("export.preset")}</Label>
                <Select value={selectedExportProfileId} onValueChange={selectPreset}>
                  <SelectTrigger id="export-preset"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {exportProfiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label htmlFor="export-presetName">{t("export.presetName")}</Label>
                <Input id="export-presetName"
                  value={exportProfiles.find((profile) => profile.id === selectedExportProfileId)?.name ?? ""}
                  onChange={(e) => onChange(renameExportPreset(draft, e.target.value))}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="grid flex-1 gap-1.5">
                <Label htmlFor="export-newPreset" className="text-xs text-muted-foreground">{t("export.newPresetPlaceholder")}</Label>
                <Input id="export-newPreset"
                  placeholder={t("export.newPresetPlaceholder")}
                  value={newPresetName}
                  onChange={(e) => setNewPresetName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") addPreset(); }}
                />
              </div>
              <Button type="button" variant="outline" size="sm" onClick={addPreset} disabled={!newPresetName.trim()}>
                <Plus className="mr-1 h-3.5 w-3.5" />{t("export.addPreset")}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={removePreset} disabled={exportProfiles.length <= 1}>
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
              <Label htmlFor="export-defaultScope">{t("export.defaultScope")}</Label>
              <Select value={exportSettings.defaultScope} onValueChange={(value) => patch({ defaultScope: value as "full" | "draft" })}>
                <SelectTrigger id="export-defaultScope"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">{t("export.publisherDraft", { count: exportSettings.sampleChapters })}</SelectItem>
                  <SelectItem value="full">{t("export.fullBook")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="export-sampleChapters">{t("export.sampleChapters")}</Label>
              <Input id="export-sampleChapters" type="number" min="1" value={exportSettings.sampleChapters} onChange={(e) => patch({ sampleChapters: Math.max(1, Number(e.target.value) || 1) })} />
            </div>
          </div>
        </div>

        <Separator />

        {/* ── Typography ── */}
        <div className="space-y-3">
          <p className="text-sm font-semibold">{t("export.typographySection")}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="export-fontFamily">{t("export.fontFamily")}</Label>
              <Select value={exportSettings.fontFamily} onValueChange={(value) => patch({ fontFamily: value as "serif" | "sans" | "mono" })}>
                <SelectTrigger id="export-fontFamily"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="serif">{t("reader.fontSerif")}</SelectItem>
                  <SelectItem value="sans">{t("reader.fontSans")}</SelectItem>
                  <SelectItem value="mono">{t("reader.fontMono")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="export-fontName">{t("export.fontName")}</Label>
              <Input id="export-fontName" value={exportSettings.fontName} onChange={(e) => patch({ fontName: e.target.value })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="export-fontSize">{t("export.fontSize")}</Label>
              <Input id="export-fontSize" type="number" min="8" max="18" value={exportSettings.fontSize} onChange={(e) => patch({ fontSize: Math.max(8, Number(e.target.value) || 12) })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="export-lineSpacing">{t("export.lineSpacing")}</Label>
              <Input id="export-lineSpacing" type="number" min="1" max="3" step="0.1" value={exportSettings.lineSpacing} onChange={(e) => patch({ lineSpacing: Number(e.target.value) || 2 })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="export-marginInches">{t("export.marginInches")}</Label>
              <Input id="export-marginInches" type="number" min="0.5" max="2" step="0.1" value={exportSettings.marginInches} onChange={(e) => patch({ marginInches: Number(e.target.value) || 1 })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="export-indentInches">{t("export.indentInches")}</Label>
              <Input id="export-indentInches" type="number" min="0" max="1" step="0.1" value={exportSettings.paragraphIndentInches} onChange={(e) => patch({ paragraphIndentInches: Math.max(0, Number(e.target.value) || 0) })} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="export-pageSize">{t("export.pageSize")}</Label>
              <Select value={exportSettings.pageSize} onValueChange={(value) => patch({ pageSize: value as "letter" | "a4" })}>
                <SelectTrigger id="export-pageSize"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="letter">Letter</SelectItem>
                  <SelectItem value="a4">A4</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="export-alignment">{t("export.alignment")}</Label>
              <Select value={exportSettings.paragraphAlignment} onValueChange={(value) => patch({ paragraphAlignment: value as "left" | "justified" })}>
                <SelectTrigger id="export-alignment"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="left">{t("export.alignLeft")}</SelectItem>
                  <SelectItem value="justified">{t("export.alignJustified")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="export-lineBreakMode">{t("export.lineBreakMode")}</Label>
              <Select value={exportSettings.lineBreakMode} onValueChange={(value) => patch({ lineBreakMode: value as "book" | "dialogue" | "source" })}>
                <SelectTrigger id="export-lineBreakMode"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="book">{t("reader.lineBreakBook")}</SelectItem>
                  <SelectItem value="dialogue">{t("reader.lineBreakDialogue")}</SelectItem>
                  <SelectItem value="source">{t("reader.lineBreakSource")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t("reader.lineBreakHint")}</p>
            </div>
            <div className="grid gap-2 sm:col-span-2">
              <Label htmlFor="export-sceneBreak">{t("export.sceneBreak")}</Label>
              <Input id="export-sceneBreak" value={exportSettings.sceneBreak} onChange={(e) => patch({ sceneBreak: e.target.value || "#" })} />
            </div>
          </div>
        </div>

        <Separator />

        {/* ── Content toggles ── */}
        <div className="space-y-3">
          <p className="text-sm font-semibold">{t("export.contentSection")}</p>
          <div className="grid gap-3 rounded-lg border border-dashed p-4">
            {[
              { key: "includeTitlePage", hint: "includeTitlePageHint", value: exportSettings.includeTitlePage, onChange: (checked: boolean) => patch({ includeTitlePage: checked }) },
              { key: "includeImages", hint: "includeImagesHint", value: exportSettings.includeImages, onChange: (checked: boolean) => patch({ includeImages: checked }) },
              { key: "includeFrontmatter", hint: "includeFrontmatterHint", value: exportSettings.includeFrontmatter, onChange: (checked: boolean) => patch({ includeFrontmatter: checked }) },
              { key: "showParagraphTitles", hint: "showParagraphTitlesHint", value: exportSettings.showParagraphTitles, onChange: (checked: boolean) => patch({ showParagraphTitles: checked }) },
              { key: "showChapterSummary", hint: "showChapterSummaryHint", value: exportSettings.showChapterSummary, onChange: (checked: boolean) => patch({ showChapterSummary: checked }) },
            ].map((row) => (
              <div key={row.key} className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-sm">{t(`export.${row.key}`)}</p>
                  <p className="text-xs text-muted-foreground">{t(`export.${row.hint}`)}</p>
                </div>
                <Switch aria-label={t(`export.${row.key}`)} checked={row.value} onCheckedChange={row.onChange} />
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
      {accessToken && (
        <GoogleDriveFolderDialog
          open={googleFolderDialogOpen}
          onOpenChange={setGoogleFolderDialogOpen}
          accessToken={accessToken}
          onSelect={(folder: DriveFolderEntry) => patch({ googleDriveFolderId: folder.id, googleDriveFolderName: folder.name })}
        />
      )}
      {accessToken && (
        <OneDriveFolderDialog
          open={oneDriveFolderDialogOpen}
          onOpenChange={setOneDriveFolderDialogOpen}
          accessToken={accessToken}
          onSelect={(folderPath) => patch({ microsoftDriveFolderPath: folderPath })}
        />
      )}
    </>
  );
}
