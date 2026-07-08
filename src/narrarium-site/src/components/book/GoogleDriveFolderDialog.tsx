import { useEffect, useState } from "react";
import { ChevronLeft, Folder, FolderPlus, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/use-toast";
import { createGoogleDriveFolder, listGoogleDriveFolders, type DriveFolderEntry } from "@/drive/exportDriveClient";

interface GoogleDriveFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accessToken: string;
  onSelect: (folder: DriveFolderEntry) => void;
}

export function GoogleDriveFolderDialog({ open, onOpenChange, accessToken, onSelect }: GoogleDriveFolderDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const rootFolder: DriveFolderEntry = { id: "root", name: t("export.myDrive") };
  const [stack, setStack] = useState<DriveFolderEntry[]>([rootFolder]);
  const [folders, setFolders] = useState<DriveFolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    setStack((current) => (current.length === 0 ? [rootFolder] : [{ id: "root", name: rootFolder.name }, ...current.slice(1)]));
  }, [rootFolder.name]);

  const current = stack[stack.length - 1] ?? rootFolder;

  useEffect(() => {
    if (!open || !accessToken) return;
    setLoading(true);
    void listGoogleDriveFolders(accessToken, current.id)
      .then(setFolders)
      .catch((err) => {
        toast({ title: t("export.folderLoadFailed"), description: String(err), variant: "destructive" });
      })
      .finally(() => setLoading(false));
  }, [accessToken, current.id, open, t, toast]);

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created = await createGoogleDriveFolder(accessToken, current.id, name);
      setFolders((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setNewFolderName("");
      setShowCreate(false);
      // Enter the new folder immediately.
      setStack((prev) => [...prev, created]);
      toast({ title: t("export.folderCreated", { name: created.name }) });
    } catch (err) {
      toast({ title: t("export.folderCreateFailed"), description: String(err), variant: "destructive" });
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("export.chooseGoogleFolder")}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
          <div>
            <p className="text-xs text-muted-foreground">{t("export.currentFolder")}</p>
            <p className="font-medium">{current.name}</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))} disabled={stack.length <= 1 || loading}>
              <ChevronLeft className="mr-1 h-4 w-4" />
              {t("export.up")}
            </Button>
            <Button type="button" size="sm" onClick={() => { onSelect(current); onOpenChange(false); }}>
              {t("export.useThisFolder")}
            </Button>
          </div>
        </div>

        {showCreate ? (
          <div className="flex items-center gap-2">
            <Input
              autoFocus
              placeholder={t("export.newFolderPlaceholder")}
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateFolder();
                if (e.key === "Escape") { setShowCreate(false); setNewFolderName(""); }
              }}
              disabled={creating}
            />
            <Button type="button" size="sm" onClick={() => void handleCreateFolder()} disabled={creating || !newFolderName.trim()}>
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : t("common.create")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => { setShowCreate(false); setNewFolderName(""); }} disabled={creating}>
              {t("common.cancel")}
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => setShowCreate(true)} disabled={loading}>
            <FolderPlus className="mr-1 h-4 w-4" />
            {t("export.newFolder")}
          </Button>
        )}

        <ScrollArea className="h-72 rounded-lg border">
          <div className="p-2">
            {loading ? (
              <div className="flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("common.loading")}
              </div>
            ) : folders.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">{t("export.noFolders")}</p>
            ) : (
              folders.map((folder) => (
                <button
                  key={folder.id}
                  type="button"
                  onClick={() => setStack((prev) => [...prev, folder])}
                  className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                >
                  <Folder className="h-4 w-4 text-primary" />
                  <span>{folder.name}</span>
                </button>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
