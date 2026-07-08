import { useEffect, useState } from "react";
import { ChevronLeft, Folder, FolderPlus, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/components/ui/use-toast";
import { createMicrosoftDriveFolder, listMicrosoftDriveFolders, type DriveFolderEntry } from "@/drive/exportDriveClient";

interface OneDriveFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accessToken: string;
  onSelect: (folderPath: string) => void;
}

interface FolderNode {
  name: string;
  path: string;
}

export function OneDriveFolderDialog({ open, onOpenChange, accessToken, onSelect }: OneDriveFolderDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const rootNode: FolderNode = { name: t("export.oneDriveRoot"), path: "" };
  const [stack, setStack] = useState<FolderNode[]>([rootNode]);
  const [folders, setFolders] = useState<DriveFolderEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");

  useEffect(() => {
    setStack((current) => (current.length === 0 ? [rootNode] : [{ name: rootNode.name, path: "" }, ...current.slice(1)]));
  }, [rootNode.name]);

  const current = stack[stack.length - 1] ?? rootNode;

  useEffect(() => {
    if (!open || !accessToken) return;
    setLoading(true);
    void listMicrosoftDriveFolders(accessToken, current.path)
      .then(setFolders)
      .catch((err) => toast({ title: t("export.folderLoadFailed"), description: String(err), variant: "destructive" }))
      .finally(() => setLoading(false));
  }, [accessToken, current.path, open, t, toast]);

  async function handleCreateFolder() {
    const name = newFolderName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const newPath = await createMicrosoftDriveFolder(accessToken, current.path, name);
      const createdName = newPath.split("/").pop() ?? name;
      setNewFolderName("");
      setShowCreate(false);
      setStack((prev) => [...prev, { name: createdName, path: newPath }]);
      toast({ title: t("export.folderCreated", { name: createdName }) });
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
          <DialogTitle>{t("export.chooseOneDriveFolder")}</DialogTitle>
        </DialogHeader>
        <div className="flex items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
          <div>
            <p className="text-xs text-muted-foreground">{t("export.currentFolder")}</p>
            <p className="font-medium">{current.path || current.name}</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => setStack((prev) => (prev.length > 1 ? prev.slice(0, -1) : prev))} disabled={stack.length <= 1 || loading}>
              <ChevronLeft className="mr-1 h-4 w-4" />
              {t("export.up")}
            </Button>
            <Button type="button" size="sm" onClick={() => { onSelect(current.path || "Apps/Narrarium/Exports"); onOpenChange(false); }}>
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
              folders.map((folder) => {
                const path = current.path ? `${current.path}/${folder.name}` : folder.name;
                return (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => setStack((prev) => [...prev, { name: folder.name, path }])}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm hover:bg-accent"
                  >
                    <Folder className="h-4 w-4 text-primary" />
                    <span>{folder.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
