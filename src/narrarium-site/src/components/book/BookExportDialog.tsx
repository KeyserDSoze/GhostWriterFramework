import { useEffect, useMemo, useState } from "react";
import { Download, FolderOpen, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BookStructure } from "@/types/book";
import type { BookEntry, BookExportScope } from "@/types/settings";
import { resolveBookExportProfiles, resolveBookExportSettings } from "@/types/settings";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { useAuthStore } from "@/store/authStore";
import { buildBookExportArtifacts, loadBookExportSnapshot, type BookExportFormat } from "@/export/bookExport";
import { uploadDriveFile, type DriveFolderEntry } from "@/drive/exportDriveClient";
import { GoogleDriveFolderDialog } from "@/components/book/GoogleDriveFolderDialog";
import { OneDriveFolderDialog } from "@/components/book/OneDriveFolderDialog";

const FORMATS: Array<{ value: BookExportFormat; labelKey: string }> = [
  { value: "docx", labelKey: "export.docx" },
  { value: "pdf", labelKey: "export.pdf" },
  { value: "epub", labelKey: "export.epub" },
  { value: "package", labelKey: "export.submissionPackage" },
];

export function BookExportDialog(props: {
  book: BookEntry;
  structure: BookStructure;
  branch: string;
  token: string;
}) {
  const { book, structure, branch, token } = props;
  const { t } = useTranslation();
  const { toast } = useToast();
  const { user, accessToken } = useAuthStore();
  const profiles = useMemo(() => resolveBookExportProfiles(book), [book]);
  const [selectedProfileId, setSelectedProfileId] = useState(book.defaultExportProfileId ?? profiles[0]?.id ?? "default");
  const savedSettings = resolveBookExportSettings(book, selectedProfileId);
  const [open, setOpen] = useState(false);
  const [formats, setFormats] = useState<BookExportFormat[]>(["docx"]);
  const [scope, setScope] = useState<BookExportScope>(savedSettings.defaultScope);
  const [downloadToDevice, setDownloadToDevice] = useState(true);
  const [uploadToDrive, setUploadToDrive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [googleFolder, setGoogleFolder] = useState<DriveFolderEntry | null>(savedSettings.googleDriveFolderId
    ? { id: savedSettings.googleDriveFolderId, name: savedSettings.googleDriveFolderName || t("export.savedFolder") }
    : null);
  const [microsoftFolderPath, setMicrosoftFolderPath] = useState(savedSettings.microsoftDriveFolderPath ?? "Apps/Narrarium/Exports");
  const [googleFolderDialogOpen, setGoogleFolderDialogOpen] = useState(false);
  const [oneDriveFolderDialogOpen, setOneDriveFolderDialogOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelectedProfileId(book.defaultExportProfileId ?? profiles[0]?.id ?? "default");
    setScope(savedSettings.defaultScope);
    setGoogleFolder(savedSettings.googleDriveFolderId ? { id: savedSettings.googleDriveFolderId, name: savedSettings.googleDriveFolderName || t("export.savedFolder") } : null);
    setMicrosoftFolderPath(savedSettings.microsoftDriveFolderPath ?? "Apps/Narrarium/Exports");
  }, [book.defaultExportProfileId, open, profiles, savedSettings.defaultScope, savedSettings.googleDriveFolderId, savedSettings.googleDriveFolderName, savedSettings.microsoftDriveFolderPath, t]);

  function toggleFormat(format: BookExportFormat) {
    setFormats((current) => {
      if (current.includes(format)) return current.filter((entry) => entry !== format);
      return [...current, format];
    });
  }

  function downloadArtifact(fileName: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 5_000);
  }

  async function handleExport() {
    if (!formats.length) return;
    if (!downloadToDevice && !uploadToDrive) {
      toast({ title: t("export.noDestination"), variant: "destructive" });
      return;
    }
    if (uploadToDrive && user?.provider === "google" && !googleFolder?.id) {
      toast({ title: t("export.chooseFolderFirst"), variant: "destructive" });
      return;
    }
    if (uploadToDrive && user?.provider === "microsoft" && !microsoftFolderPath.trim()) {
      toast({ title: t("export.chooseFolderFirst"), variant: "destructive" });
      return;
    }
    if (uploadToDrive && (!user || !accessToken)) {
      toast({ title: t("export.driveUnavailable"), variant: "destructive" });
      return;
    }

    setBusy(true);
    try {
      const snapshot = await loadBookExportSnapshot({
        token,
        book,
        branch,
        structure,
        scope,
        exportSettings: savedSettings,
      });
      const artifacts = await buildBookExportArtifacts({
        snapshot,
        scope,
        settings: savedSettings,
        formats,
      });

      if (downloadToDevice) {
        artifacts.forEach((artifact) => downloadArtifact(artifact.fileName, artifact.blob));
      }

      if (uploadToDrive && user && accessToken) {
        for (const artifact of artifacts) {
          await uploadDriveFile(user.provider, accessToken, {
            googleFolderId: googleFolder?.id,
            microsoftFolderPath,
            fileName: artifact.fileName,
            mimeType: artifact.mimeType,
            blob: artifact.blob,
          });
        }
      }

      toast({ title: t("export.success", { count: artifacts.length }) });
      setOpen(false);
    } catch (err) {
      toast({ title: t("export.failed"), description: String(err), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Download className="mr-1 h-4 w-4" />
            {t("export.title")}
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t("export.title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-5">
            {profiles.length > 1 && (
              <div className="grid gap-2">
                <Label>{t("export.preset")}</Label>
                <Select value={selectedProfileId} onValueChange={setSelectedProfileId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {profiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="grid gap-2">
              <Label>{t("export.formats")}</Label>
              <div className="flex flex-wrap gap-2">
                {FORMATS.map((format) => {
                  const active = formats.includes(format.value);
                  return (
                    <Button key={format.value} type="button" variant={active ? "default" : "outline"} size="sm" onClick={() => toggleFormat(format.value)}>
                      {t(format.labelKey)}
                    </Button>
                  );
                })}
              </div>
            </div>

            <div className="grid gap-2">
              <Label>{t("export.scope")}</Label>
              <Select value={scope} onValueChange={(value) => setScope(value as BookExportScope)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="draft">{t("export.publisherDraft", { count: savedSettings.sampleChapters })}</SelectItem>
                  <SelectItem value="full">{t("export.fullBook")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{t("export.downloadToDevice")}</p>
                  <p className="text-xs text-muted-foreground">{t("export.downloadHint")}</p>
                </div>
                <Switch checked={downloadToDevice} onCheckedChange={setDownloadToDevice} />
              </div>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{t("export.uploadToDrive")}</p>
                  <p className="text-xs text-muted-foreground">{t("export.uploadHint")}</p>
                </div>
                <Switch checked={uploadToDrive} onCheckedChange={setUploadToDrive} />
              </div>
              {uploadToDrive && user?.provider === "google" && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2">
                  <div>
                    <p className="text-xs text-muted-foreground">{t("export.googleFolder")}</p>
                    <p className="font-medium">{googleFolder?.name ?? t("export.noFolderSelected")}</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setGoogleFolderDialogOpen(true)} disabled={!accessToken}>
                    <FolderOpen className="mr-1 h-4 w-4" />
                    {t("export.chooseFolder")}
                  </Button>
                </div>
              )}
              {uploadToDrive && user?.provider === "microsoft" && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-muted/20 px-3 py-2">
                  <div>
                    <p className="text-xs text-muted-foreground">{t("export.microsoftFolderPath")}</p>
                    <p className="font-medium">{microsoftFolderPath || t("export.noFolderSelected")}</p>
                  </div>
                  <Button type="button" variant="outline" size="sm" onClick={() => setOneDriveFolderDialogOpen(true)} disabled={!accessToken}>
                    <FolderOpen className="mr-1 h-4 w-4" />
                    {t("export.chooseFolder")}
                  </Button>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>{t("common.cancel")}</Button>
            <Button onClick={() => void handleExport()} disabled={busy || formats.length === 0}>
              {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Download className="mr-1 h-4 w-4" />}
              {t("export.start")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {accessToken && (
        <GoogleDriveFolderDialog
          open={googleFolderDialogOpen}
          onOpenChange={setGoogleFolderDialogOpen}
          accessToken={accessToken}
          onSelect={setGoogleFolder}
        />
      )}
      {accessToken && (
        <OneDriveFolderDialog
          open={oneDriveFolderDialogOpen}
          onOpenChange={setOneDriveFolderDialogOpen}
          accessToken={accessToken}
          onSelect={setMicrosoftFolderPath}
        />
      )}
    </>
  );
}
