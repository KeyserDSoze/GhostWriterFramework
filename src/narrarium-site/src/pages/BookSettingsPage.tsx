import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, FolderOpen, GitBranch, KeyRound, Loader2, Plus, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/use-toast";
import { useSettings } from "@/drive/useSettings";
import { useSettingsStore } from "@/store/settingsStore";
import { useBooksStore } from "@/store/booksStore";
import { resolveBookExportProfiles, resolveBookExportSettings, resolveBookToken, type BookEntry, type BookExportProfile, type BookExportSettings } from "@/types/settings";
import { createBranchFromBase, getDefaultBranch, listBranches } from "@/github/githubClient";
import { useAuthStore } from "@/store/authStore";
import { GoogleDriveFolderDialog } from "@/components/book/GoogleDriveFolderDialog";
import { OneDriveFolderDialog } from "@/components/book/OneDriveFolderDialog";
import type { DriveFolderEntry } from "@/drive/exportDriveClient";

type TokenMode = "default" | "custom" | string;

function initialMode(book: BookEntry): TokenMode {
  if (book.bookToken) return "custom";
  if (book.tokenIndex != null) return String(book.tokenIndex);
  return "default";
}

export function BookSettingsPage() {
  const { t } = useTranslation();
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { settings, patchSettings } = useSettingsStore();
  const { save, syncStatus } = useSettings();
  const { clearBook, structures, workingBranches } = useBooksStore();
  const { user, accessToken } = useAuthStore();

  const book = settings.books.find((entry) => entry.id === bookId);
  const structure = bookId ? structures[bookId] : undefined;

  const [name, setName] = useState(book?.name ?? "");
  const [mode, setMode] = useState<TokenMode>(book ? initialMode(book) : "default");
  const [customToken, setCustomToken] = useState(book?.bookToken ?? "");
  const [customTokenLabel, setCustomTokenLabel] = useState(book?.bookTokenLabel ?? "");
  const [branches, setBranches] = useState<string[]>([]);
  const [activeBranch, setActiveBranch] = useState(book?.activeBranch ?? "__auto__");
  const [newBranchName, setNewBranchName] = useState("");
  const [baseBranch, setBaseBranch] = useState(structure?.defaultBranch ?? "main");
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [googleFolderDialogOpen, setGoogleFolderDialogOpen] = useState(false);
  const [oneDriveFolderDialogOpen, setOneDriveFolderDialogOpen] = useState(false);
  const fallbackBook = book ?? {
    id: "",
    owner: "",
    repo: "",
    name: "",
    tokenIndex: null,
    addedAt: "",
  };
  const [exportProfiles, setExportProfiles] = useState<BookExportProfile[]>(() => resolveBookExportProfiles(fallbackBook));
  const [selectedExportProfileId, setSelectedExportProfileId] = useState(() => book?.defaultExportProfileId ?? resolveBookExportProfiles(fallbackBook)[0]?.id ?? "default");
  const [newPresetName, setNewPresetName] = useState("");
  const [exportSettings, setExportSettings] = useState<BookExportSettings>(() => resolveBookExportSettings(fallbackBook));

  useEffect(() => {
    if (!book) return;
    const profiles = resolveBookExportProfiles(book);
    const selectedId = book.defaultExportProfileId ?? profiles[0]?.id ?? "default";
    setExportProfiles(profiles);
    setSelectedExportProfileId(selectedId);
    setExportSettings(resolveBookExportSettings(book, selectedId));
  }, [book]);

  useEffect(() => {
    if (!book) return;
    const selected = exportProfiles.find((profile) => profile.id === selectedExportProfileId) ?? exportProfiles[0];
    if (!selected) return;
    setExportSettings(resolveBookExportSettings({ ...book, exportProfiles }, selected.id));
  }, [book, exportProfiles, selectedExportProfileId]);

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

  useEffect(() => {
    if (!book) return;
    const token = resolveBookToken(book, settings);
    if (!token) return;
    setLoadingBranches(true);
    Promise.all([
      listBranches(token, book.owner, book.repo),
      getDefaultBranch(token, book.owner, book.repo),
    ])
      .then(([items, defaultBranch]) => {
        setBranches(items.map((entry) => entry.name));
        setBaseBranch(defaultBranch);
      })
      .catch((err) => {
        toast({ title: t("bookSettings.loadBranchesFailed"), description: String(err), variant: "destructive" });
      })
      .finally(() => setLoadingBranches(false));
  }, [book, settings, toast, t]);

  if (!book) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t("bookSettings.notFound")} <Link to="/app/books" className="underline">{t("bookSettings.backToBooks")}</Link>
        </AlertDescription>
      </Alert>
    );
  }

  const currentBook = book;
  const isSaving = syncStatus === "saving";
  const currentToken = resolveBookToken(currentBook, settings);
  const currentAutoBranch = workingBranches[currentBook.id] ?? (structure?.defaultBranch ?? "main");

  async function handleSave() {
    const usingCustom = mode === "custom";
      const updated: BookEntry = {
        ...currentBook,
        name: name.trim() || currentBook.repo,
      tokenIndex: mode === "default" || usingCustom ? null : Number(mode),
      bookToken: usingCustom ? customToken.trim() || undefined : undefined,
      bookTokenLabel: usingCustom ? customTokenLabel.trim() || `${currentBook.repo} PAT` : undefined,
      activeBranch: activeBranch === "__auto__" ? undefined : activeBranch,
      exportSettings,
      exportProfiles,
      defaultExportProfileId: selectedExportProfileId,
    };

    patchSettings({ books: settings.books.map((entry) => (entry.id === currentBook.id ? updated : entry)) });
    await save();
    clearBook(currentBook.id);
    toast({ title: t("bookSettings.settingsSaved") });
    navigate(`/app/books/${currentBook.id}`);
  }

  async function handleCreateBranch() {
    if (!newBranchName.trim()) return;
    const token = resolveBookToken(currentBook, settings);
    if (!token) {
      toast({ title: t("bookSettings.missingToken"), description: t("bookSettings.configureTokenFirst"), variant: "destructive" });
      return;
    }
    setCreatingBranch(true);
    try {
      const nextBranch = newBranchName.trim();
      await createBranchFromBase(token, currentBook.owner, currentBook.repo, baseBranch, nextBranch);
      setBranches((prev) => [...prev, nextBranch].sort());
      setActiveBranch(nextBranch);
      setNewBranchName("");
      toast({ title: t("bookSettings.branchCreated", { branch: nextBranch }) });
    } catch (err) {
      toast({ title: t("bookSettings.branchCreateFailed"), description: String(err), variant: "destructive" });
    } finally {
      setCreatingBranch(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to={`/app/books/${currentBook.id}`}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          {currentBook.name}
        </Link>
      </Button>

      <div>
        <h1 className="font-serif text-3xl font-semibold tracking-tight">{t("bookSettings.title")}</h1>
        <p className="text-muted-foreground">{currentBook.owner}/{currentBook.repo}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("bookSettings.general")}</CardTitle>
          <CardDescription>{t("bookSettings.generalDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="book-name">{t("bookSettings.name")}</Label>
            <Input id="book-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><GitBranch className="h-4 w-4" />{t("bookSettings.branchWorkspace")}</CardTitle>
          <CardDescription>
            {t("bookSettings.branchDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>{t("bookSettings.activeBranch")}</Label>
            <Select value={activeBranch} onValueChange={setActiveBranch} disabled={loadingBranches}>
              <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__auto__">{t("bookSettings.autoDevBranch", { branch: currentAutoBranch })}</SelectItem>
                {branches.map((branch) => (
                  <SelectItem key={branch} value={branch}>{branch}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("bookSettings.defaultBranch")} {baseBranch}</p>
          </div>

          <div className="grid gap-2 rounded-lg border border-dashed p-3">
            <p className="text-xs text-muted-foreground">{t("bookSettings.createBranchHint", { base: baseBranch })}</p>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input placeholder="feature/new-arc" value={newBranchName} onChange={(e) => setNewBranchName(e.target.value)} />
              <Button onClick={() => void handleCreateBranch()} disabled={creatingBranch || !newBranchName.trim()}>
                {creatingBranch ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                {t("bookSettings.createBranch")}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" />{t("bookSettings.githubAccess")}</CardTitle>
          <CardDescription>
            {t("bookSettings.githubAccessDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2">
            <Label>{t("bookSettings.token")}</Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">{t("bookSettings.defaultTokenOption")}{settings.defaultGitHubToken ? ` (…${settings.defaultGitHubToken.slice(-4)})` : t("bookSettings.notSet")}</SelectItem>
                {settings.extraGitHubTokens.map((token, i) => <SelectItem key={i} value={String(i)}>{token.label} (…{token.token.slice(-4)})</SelectItem>)}
                <SelectItem value="custom">{t("bookSettings.dedicatedPat")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {mode === "custom" && (
            <div className="grid gap-2 rounded-lg border border-dashed p-3">
              <p className="text-xs text-muted-foreground">{t("bookSettings.dedicatedHint")}</p>
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
                <Input placeholder={t("bookSettings.labelOptional")} value={customTokenLabel} onChange={(e) => setCustomTokenLabel(e.target.value)} />
                <Input type="password" placeholder="github_pat_…" value={customToken} onChange={(e) => setCustomToken(e.target.value)} autoComplete="off" />
              </div>
              <p className="text-[11px] text-muted-foreground">{t("bookSettings.createOneAt")} <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="underline">github.com/settings/tokens</a> {t("bookSettings.withPermissions")}</p>
            </div>
          )}

          {!currentToken && mode !== "custom" && (
            <Alert variant="destructive"><AlertDescription>{t("bookSettings.noTokenWarning")}</AlertDescription></Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("export.settingsTitle")}</CardTitle>
          <CardDescription>{t("export.settingsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 rounded-lg border border-dashed p-3">
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <div className="grid gap-2">
                <Label>{t("export.preset")}</Label>
                <Select value={selectedExportProfileId} onValueChange={setSelectedExportProfileId}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {exportProfiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>{t("export.presetName")}</Label>
                <Input value={exportProfiles.find((profile) => profile.id === selectedExportProfileId)?.name ?? ""} onChange={(e) => setExportProfiles((current) => current.map((profile) => profile.id === selectedExportProfileId ? { ...profile, name: e.target.value } : profile))} />
              </div>
              <div className="flex items-end gap-2">
                <Button type="button" variant="outline" onClick={addExportPreset} disabled={!newPresetName.trim()}>{t("export.addPreset")}</Button>
                <Button type="button" variant="ghost" onClick={removeCurrentExportPreset} disabled={exportProfiles.length <= 1}>{t("export.removePreset")}</Button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
              <Input placeholder={t("export.newPresetPlaceholder")} value={newPresetName} onChange={(e) => setNewPresetName(e.target.value)} />
              <Button type="button" variant="outline" onClick={addExportPreset} disabled={!newPresetName.trim()}>{t("export.addPreset")}</Button>
            </div>
          </div>

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
              <Label>{t("export.sceneBreak")}</Label>
              <Input value={exportSettings.sceneBreak} onChange={(e) => patchExportSettings({ sceneBreak: e.target.value || "#" })} />
            </div>
          </div>

          <div className="grid gap-3 rounded-lg border border-dashed p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">{t("export.includeTitlePage")}</p>
                <p className="text-xs text-muted-foreground">{t("export.includeTitlePageHint")}</p>
              </div>
              <Switch checked={exportSettings.includeTitlePage} onCheckedChange={(checked) => patchExportSettings({ includeTitlePage: checked })} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">{t("export.showParagraphTitles")}</p>
                <p className="text-xs text-muted-foreground">{t("export.showParagraphTitlesHint")}</p>
              </div>
              <Switch checked={exportSettings.showParagraphTitles} onCheckedChange={(checked) => patchExportSettings({ showParagraphTitles: checked })} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="font-medium">{t("export.showChapterSummary")}</p>
                <p className="text-xs text-muted-foreground">{t("export.showChapterSummaryHint")}</p>
              </div>
              <Switch checked={exportSettings.showChapterSummary} onCheckedChange={(checked) => patchExportSettings({ showChapterSummary: checked })} />
            </div>
          </div>

          {user?.provider === "google" ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
              <div>
                <p className="text-xs text-muted-foreground">{t("export.googleFolder")}</p>
                <p className="font-medium">{exportSettings.googleDriveFolderName ?? t("export.noFolderSelected")}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setGoogleFolderDialogOpen(true)} disabled={!accessToken}>
                <FolderOpen className="mr-1 h-4 w-4" />
                {t("export.chooseFolder")}
              </Button>
            </div>
          ) : user?.provider === "microsoft" ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/20 px-3 py-2">
              <div>
                <p className="text-xs text-muted-foreground">{t("export.microsoftFolderPath")}</p>
                <p className="font-medium">{exportSettings.microsoftDriveFolderPath ?? t("export.noFolderSelected")}</p>
              </div>
              <Button type="button" variant="outline" size="sm" onClick={() => setOneDriveFolderDialogOpen(true)} disabled={!accessToken}>
                <FolderOpen className="mr-1 h-4 w-4" />
                {t("export.chooseFolder")}
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => void handleSave()} disabled={isSaving}>
          {isSaving ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Save className="mr-1 h-4 w-4" />}
          {t("settings.save")}
        </Button>
      </div>

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
    </div>
  );
}
