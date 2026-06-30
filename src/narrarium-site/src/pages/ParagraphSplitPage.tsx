import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Loader2, Save, Columns2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { resolveBookToken } from "@/types/settings";
import { readFileWithSha, updateFile, createOrUpdateTextFile } from "@/github/githubClient";
import { useRegisterProseEditor } from "@/components/editor/useRegisterProseEditor";
import { useRegisterPageSave } from "@/store/saveStore";
import { useProseAssist } from "@/components/editor/useProseAssist";
import type { PipelineSource } from "@/narrarium/pipeline";

/** Split a markdown file into its frontmatter block (kept verbatim) and the body. */
function splitDoc(raw: string): { frontmatter: string; body: string } {
  const match = raw.match(/^(---\r?\n[\s\S]*?\r?\n---\r?\n?)([\s\S]*)$/);
  if (match) return { frontmatter: match[1], body: match[2].replace(/^\s*\n/, "") };
  return { frontmatter: "", body: raw };
}

function joinDoc(frontmatter: string, body: string): string {
  if (!frontmatter) return `${body.trim()}\n`;
  return `${frontmatter.trimEnd()}\n\n${body.trim()}\n`;
}

function paragraphSlug(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.md$/i, "");
}

interface PaneState {
  loading: boolean;
  exists: boolean;
  frontmatter: string;
  body: string;
  savedBody: string;
  sha: string;
  saving: boolean;
}

const EMPTY_PANE: PaneState = { loading: true, exists: false, frontmatter: "", body: "", savedBody: "", sha: "", saving: false };

export function ParagraphSplitPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { bookId, chapterId, paragraphNum } = useParams<{ bookId: string; chapterId: string; paragraphNum: string }>();
  const { book, structure, loading: structureLoading, reload } = useBookStructure(bookId);
  const { branch } = useWorkingBranch(bookId);

  const chapter = structure?.chapters.find((c) => c.slug === chapterId);
  const paragraph = chapter?.paragraphs.find((p) => p.number === paragraphNum);
  const token = book ? resolveBookToken(book, settings) : "";

  const draftPath = useMemo(() => {
    if (!chapter || !paragraph) return "";
    return paragraph.draftPath ?? `${chapter.path}/drafts/${paragraphSlug(paragraph.path)}.md`;
  }, [chapter, paragraph]);
  const finalPath = paragraph?.path ?? "";

  const [draft, setDraft] = useState<PaneState>(EMPTY_PANE);
  const [final, setFinal] = useState<PaneState>(EMPTY_PANE);
  const loadedRef = useRef<string>("");

  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const finalRef = useRef<HTMLTextAreaElement | null>(null);

  const buildSource = (): PipelineSource | null => {
    if (!book || !structure || !chapter) return null;
    return { token, owner: book.owner, repo: book.repo, branch, settings, structure, chapter };
  };

  const draftAssist = useProseAssist({ textareaRef: draftRef, getBody: () => draft.body, setBody: (v) => setDraft((s) => ({ ...s, body: v })), buildSource });
  const finalAssist = useProseAssist({ textareaRef: finalRef, getBody: () => final.body, setBody: (v) => setFinal((s) => ({ ...s, body: v })), buildSource });

  useRegisterProseEditor(draftRef, { improve: draftAssist.improve, synonym: draftAssist.synonym });
  useRegisterProseEditor(finalRef, { improve: finalAssist.improve, synonym: finalAssist.synonym });

  // Load both files.
  useEffect(() => {
    if (!book || !token || !finalPath || !draftPath) return;
    const key = `${branch}:${draftPath}:${finalPath}`;
    if (loadedRef.current === key) return;
    loadedRef.current = key;
    setDraft({ ...EMPTY_PANE, loading: true });
    setFinal({ ...EMPTY_PANE, loading: true });

    readFileWithSha(token, book.owner, book.repo, branch, finalPath)
      .then(({ content, sha }) => {
        const { frontmatter, body } = splitDoc(content);
        setFinal({ loading: false, exists: true, frontmatter, body, savedBody: body, sha, saving: false });
      })
      .catch(() => setFinal({ ...EMPTY_PANE, loading: false }));

    readFileWithSha(token, book.owner, book.repo, branch, draftPath)
      .then(({ content, sha }) => {
        const { frontmatter, body } = splitDoc(content);
        setDraft({ loading: false, exists: true, frontmatter, body, savedBody: body, sha, saving: false });
      })
      .catch(() => setDraft({ ...EMPTY_PANE, loading: false, exists: false }));
  }, [book, token, branch, draftPath, finalPath]);

  const draftDirty = draft.body !== draft.savedBody;
  const finalDirty = final.body !== final.savedBody;

  async function saveDraft() {
    if (!book || !draftDirty) return;
    setDraft((s) => ({ ...s, saving: true }));
    try {
      await createOrUpdateTextFile(token, book.owner, book.repo, branch, draftPath, joinDoc(draft.frontmatter, draft.body), `Update draft ${paragraphSlug(finalPath)}`);
      setDraft((s) => ({ ...s, savedBody: s.body, exists: true, saving: false }));
      toast({ title: t("common.saved") });
      if (!draft.exists) void reload();
    } catch (err) {
      setDraft((s) => ({ ...s, saving: false }));
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    }
  }

  async function saveFinal() {
    if (!book || !finalDirty || !final.exists) return;
    setFinal((s) => ({ ...s, saving: true }));
    try {
      const newSha = await updateFile(token, book.owner, book.repo, branch, finalPath, final.sha, joinDoc(final.frontmatter, final.body), `Update paragraph ${paragraphSlug(finalPath)}`);
      setFinal((s) => ({ ...s, savedBody: s.body, sha: newSha, saving: false }));
      toast({ title: t("common.saved") });
    } catch (err) {
      setFinal((s) => ({ ...s, saving: false }));
      toast({ title: t("common.saveFailed"), description: String(err), variant: "destructive" });
    }
  }

  // Ctrl+S saves whichever sides are dirty.
  useRegisterPageSave({
    dirty: draftDirty || finalDirty,
    enabled: Boolean(book && token),
    onSave: async () => { await saveDraft(); await saveFinal(); },
  });

  if (structureLoading && !structure) {
    return <div className="space-y-2"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  }
  if (!book || !paragraph || !chapter) {
    return <Alert variant="destructive"><AlertDescription>{t("workspace.notFound")} <Link to={`/app/books/${bookId}`} className="underline">{t("workspace.backToBook")}</Link></AlertDescription></Alert>;
  }

  const backBase = `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${paragraph.number}`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 font-serif text-xl font-semibold">
          <Columns2 className="h-5 w-5" />{t("paragraph.splitTitle", { title: paragraph.title })}
        </h1>
        <Link to={backBase} className="text-sm text-muted-foreground underline">{t("paragraph.backToFinal")}</Link>
      </div>

      {/* Desktop-only split. Panes flow with the page (no inner scroll) and grow with content. */}
      <div className="hidden grid-cols-2 items-start gap-4 lg:grid">
        <Pane
          title={t("chapter.draft")}
          loading={draft.loading}
          body={draft.body}
          onChange={(v) => setDraft((s) => ({ ...s, body: v }))}
          dirty={draftDirty}
          saving={draft.saving}
          onSave={() => void saveDraft()}
          textareaRef={draftRef}
          placeholder={t("workspace.writeBodyPlaceholder")}
          createHint={!draft.exists ? t("paragraph.draftMissingHint") : undefined}
        />
        <Pane
          title={t("stageIndex.final")}
          loading={final.loading}
          body={final.body}
          onChange={(v) => setFinal((s) => ({ ...s, body: v }))}
          dirty={finalDirty}
          saving={final.saving}
          onSave={() => void saveFinal()}
          textareaRef={finalRef}
          placeholder={t("paragraph.writePlaceholder")}
        />
      </div>

      <div className="lg:hidden">
        <Alert><AlertDescription>{t("paragraph.splitDesktopOnly")}</AlertDescription></Alert>
      </div>

      {draftAssist.dialogs}
      {finalAssist.dialogs}
    </div>
  );
}

function Pane(props: {
  title: string;
  loading: boolean;
  body: string;
  onChange: (value: string) => void;
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  placeholder: string;
  createHint?: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col rounded-xl border bg-card">
      <div className="sticky top-0 z-10 flex items-center justify-between rounded-t-xl border-b bg-card px-3 py-2">
        <span className="text-sm font-semibold">{props.title}{props.dirty ? " •" : ""}</span>
        <Button size="sm" variant="outline" onClick={props.onSave} disabled={!props.dirty || props.saving}>
          {props.saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1 h-3.5 w-3.5" />}
          {t("common.save")}
        </Button>
      </div>
      <div className="p-3">
        {props.loading ? (
          <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <>
            {props.createHint && <p className="mb-2 text-xs text-muted-foreground">{props.createHint}</p>}
            <AutoTextarea
              ref={props.textareaRef}
              value={props.body}
              onChange={(e) => props.onChange(e.target.value)}
              className="resize-none border-0 p-0 font-mono text-sm leading-7 focus-visible:ring-0 focus-visible:ring-offset-0"
              placeholder={props.placeholder}
              spellCheck={false}
            />
          </>
        )}
      </div>
    </div>
  );
}
