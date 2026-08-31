import { useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft, FileEdit, FileText, Network, Wand2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/use-toast";
import { useSettingsStore } from "@/store/settingsStore";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useBookStructure } from "@/hooks/useBookStructure";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { resolveBookToken } from "@/types/settings";
import { isGitHubFileNotFoundError, loadFileContent, mutateTextFilesAtomically, readFileWithSha } from "@/github/githubClient";
import { parseDocument, stringify } from "yaml";
import { GeneratePreviewDialog } from "@/components/book/GeneratePreviewDialog";
import { proseToScript, refineProse, scriptToProse, stripFrontmatter, type PipelineSource } from "@/narrarium/pipeline";
import { commitCanonicalScriptMutation } from "@/narrarium/scriptLedger";
import { sha256Text } from "@/repository/safeRepositoryMutation";
import { localWorkspaceScope } from "@/account/deviceIdentity";

type Stage = "drafts" | "scripts";
type GenKind = "draft" | "final" | "script";

export function ChapterStageIndexPage({ stage }: { stage: Stage }) {
  const { bookId, chapterId } = useParams<{ bookId: string; chapterId: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, loading, error, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const chapter = structure?.chapters.find((c) => c.slug === chapterId);

  const [genOpen, setGenOpen] = useState(false);
  const [genKind, setGenKind] = useState<GenKind>("draft");
  const [genText, setGenText] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [genGw, setGenGw] = useState("");
  const [genPara, setGenPara] = useState<string>("");
  const [genFrontmatter, setGenFrontmatter] = useState<Record<string, unknown>>({});
  const genTargetHashRef = useRef<string | null>(null);

  if (error && !structure) return <BookStructureErrorAlert error={error} reload={reload} />;
  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  if (loading && !structure) {
    return <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  }
  if (!chapter) {
    return <Alert variant="destructive"><AlertDescription>{t("workspace.notFound")} <Link to={`/app/books/${bookId}`} className="underline">{t("workspace.backToBook")}</Link></AlertDescription></Alert>;
  }

  const src = (paragraph?: typeof chapter.paragraphs[number]): PipelineSource => ({ token, owner: book.owner, repo: book.repo, branch, settings, structure: structure!, chapter, paragraph, accountScope: localWorkspaceScope() });

  function paraSlugOf(path: string) { return (path.split("/").pop() ?? "").replace(/\.md$/i, ""); }

  async function startGen(kind: GenKind, _paraNumber: string, paraSlug: string) {
    // Open the preview empty; generation only starts when the user clicks Generate.
    const chapterRef = chapter!;
    const bookRef = book!;
    const targetPath = kind === "script" ? `scripts/${chapterRef.slug}/${paraSlug}.md` : kind === "draft" ? `drafts/${chapterRef.slug}/${paraSlug}.md` : `${chapterRef.path}/${paraSlug}.md`;
    let targetRaw = "";
    try {
      targetRaw = (await readFileWithSha(token, bookRef.owner, bookRef.repo, branch, targetPath)).content;
      const hash = await sha256Text(targetRaw);
      genTargetHashRef.current = hash;
    } catch (error) {
      if (!isGitHubFileNotFoundError(error)) { toast({ title: t("workspace.loadFailed"), description: String(error), variant: "destructive" }); return; }
      genTargetHashRef.current = null;
    }
    const targetFrontmatter = frontmatterFromMarkdown(targetRaw);
    let selectedGhostwriter = typeof targetFrontmatter.ghostwriter === "string" ? targetFrontmatter.ghostwriter : "";
    if (!selectedGhostwriter && kind === "draft") {
      const paragraph = chapterRef.paragraphs.find((entry) => paraSlugOf(entry.path) === paraSlug);
      if (paragraph?.scriptPath) {
        const raw = await loadFileContent(token, bookRef.owner, bookRef.repo, paragraph.scriptPath, branch).catch(() => "");
        const scriptFrontmatter = frontmatterFromMarkdown(raw);
        selectedGhostwriter = typeof scriptFrontmatter.ghostwriter === "string" ? scriptFrontmatter.ghostwriter : "";
      }
    }
    setGenKind(kind); setGenPara(paraSlug); setGenGw(selectedGhostwriter); setGenFrontmatter(targetFrontmatter); setGenText(""); setGenOpen(true); setGenLoading(false);
  }

  async function runGen() {
    const kind = genKind;
    const paraSlug = genPara;
    const paraNumber = paraSlug.match(/^(\d{3})/)?.[1] ?? "";
    setGenLoading(true);
    try {
      const p = chapter!.paragraphs.find((x) => x.number === paraNumber || paraSlugOf(x.path) === paraSlug);
      if (!p) throw new Error("paragraph not found");
      const load = (path?: string) => path ? loadFileContent(token, book!.owner, book!.repo, path, branch).then(stripFrontmatter).catch(() => "") : Promise.resolve("");
      if (kind === "script") {
        const prose = (await load(p.draftPath)) || (await load(p.path));
        setGenText(await proseToScript(src(p), prose, genGw));
      } else if (kind === "draft") {
        const script = await load(p.scriptPath);
        setGenText(await scriptToProse(src(p), script, genGw));
      } else {
        const draft = (await load(p.draftPath)) || (await load(p.path));
        setGenText(await refineProse(src(p), draft, genGw));
      }
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    } finally { setGenLoading(false); }
  }

  async function applyGen() {
    const p = chapter!.paragraphs.find((x) => paraSlugOf(x.path) === genPara);
    if (!p) return;
    const number = Number(genPara.match(/^(\d{3})/)?.[1] ?? "1");
    const titleText = p.title;
    let path = "";
    let fm: Record<string, unknown> = {};
    if (genKind === "script") {
      path = `scripts/${chapter!.slug}/${genPara}.md`;
      fm = { ...genFrontmatter, type: "script", id: `script:${chapter!.slug}:${genPara}`, chapter: `chapter:${chapter!.slug}`, paragraph: `paragraph:${chapter!.slug}:${genPara}`, number, title: titleText };
    } else if (genKind === "draft") {
      path = `drafts/${chapter!.slug}/${genPara}.md`;
      fm = { ...genFrontmatter, type: "paragraph-draft", id: `draft:paragraph:${chapter!.slug}:${genPara}`, paragraph: `paragraph:${chapter!.slug}:${genPara}`, chapter: `chapter:${chapter!.slug}`, number, title: titleText, canon: "draft" };
    } else {
      path = `${chapter!.path}/${genPara}.md`;
      fm = { ...genFrontmatter, type: "paragraph", id: `paragraph:${chapter!.slug}:${genPara}`, chapter: `chapter:${chapter!.slug}`, number, title: titleText };
    }
    if (genGw) fm.ghostwriter = genGw;
    else delete fm.ghostwriter;
    const content = `---\n${stringify(fm).trim()}\n---\n\n${genText.trim()}\n`;
    try {
      if (genKind === "script") {
        const result = await commitCanonicalScriptMutation({ token, book: book!, branch, message: `Generate ${path}`, mutations: [{ path, content, expectedCurrentHash: genTargetHashRef.current }] });
        toast({ title: result.changed ? t("pipeline.created", { path }) : t("common.saved"), description: result.warningCount ? result.checks.filter((check) => check.severity === "warning").map((check) => check.message).join("\n") : undefined });
      } else {
        await mutateTextFilesAtomically(token, book!.owner, book!.repo, branch, [{ path, content, expectedCurrentHash: genTargetHashRef.current }], `Generate ${path}`);
        toast({ title: t("pipeline.created", { path }) });
      }
      setGenOpen(false);
      reload();
    } catch (err) {
      toast({ title: t("pipeline.failed"), description: String(err), variant: "destructive" });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2 w-fit">
        <Link to={`/app/books/${bookId}/chapters/${chapterId}`}><ArrowLeft className="mr-1 h-4 w-4" />{chapter.title}</Link>
      </Button>
      <div>
        <h1 className="font-serif text-2xl font-semibold">{stage === "scripts" ? t("nav.scriptsIndex") : t("nav.draftsIndex")}</h1>
        <p className="text-sm text-muted-foreground">{stage === "scripts" ? t("stageIndex.scriptsIntro") : t("stageIndex.draftsIntro")}</p>
      </div>

      <div className="space-y-2">
        {chapter.paragraphs.map((p) => {
          const slug = paraSlugOf(p.path);
          const base = `/app/books/${bookId}/chapters/${chapterId}/paragraphs/${p.number}`;
          return (
            <div key={p.number} className="rounded-xl border p-3">
              <div className="mb-2 flex items-center gap-2">
                <Badge variant="outline" className="font-mono text-[11px]">{p.number}</Badge>
                <span className="font-medium">{p.title}</span>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <StageLink active={!!p.scriptPath} href={`${base}/workspace/script`} icon={<Network className="h-3.5 w-3.5" />} label={t("chapter.script")} missing={t("stageIndex.noScript")} />
                <StageLink active={!!p.draftPath} href={`${base}/workspace/draft`} icon={<FileEdit className="h-3.5 w-3.5" />} label={t("chapter.draft")} missing={t("stageIndex.noDraft")} />
                <StageLink active href={base} icon={<FileText className="h-3.5 w-3.5" />} label={t("stageIndex.final")} missing="" />
                <span className="mx-1 h-4 w-px bg-border" />
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => void startGen("script", p.number, slug)}><Wand2 className="h-3.5 w-3.5" />{t("stageIndex.genScript")}</Button>
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => void startGen("draft", p.number, slug)}><Wand2 className="h-3.5 w-3.5" />{t("stageIndex.genDraft")}</Button>
                <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => void startGen("final", p.number, slug)}><Wand2 className="h-3.5 w-3.5" />{t("stageIndex.genFinal")}</Button>
              </div>
            </div>
          );
        })}
      </div>

      <GeneratePreviewDialog
        open={genOpen}
        title={genKind === "script" ? t("stageIndex.genScript") : genKind === "draft" ? t("pipeline.scriptToDraft") : t("pipeline.draftToFinal")}
        description={genKind === "script" ? t("stageIndex.genScriptDesc") : genKind === "draft" ? t("pipeline.scriptToDraftDesc") : t("pipeline.draftToFinalDesc")}
        text={genText}
        loading={genLoading}
        ghostwriters={structure?.ghostwriters ?? []}
        ghostwriter={genGw}
        onGhostwriter={setGenGw}
        onRegenerate={() => void runGen()}
        onChange={setGenText}
        onConfirm={() => void applyGen()}
        onCancel={() => setGenOpen(false)}
      />
    </div>
  );
}

function frontmatterFromMarkdown(raw: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!match) return {};
  const document = parseDocument(match[1]);
  if (document.errors.length) throw new Error(document.errors[0].message);
  return document.toJSON() as Record<string, unknown> | null ?? {};
}

function StageLink({ active, href, icon, label, missing }: { active: boolean; href: string; icon: React.ReactNode; label: string; missing: string }) {
  if (!active && missing) {
    return <span className="flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs text-muted-foreground/60">{icon}{missing}</span>;
  }
  return (
    <Button asChild size="sm" variant="outline" className="h-7 gap-1 text-xs">
      <Link to={href}>{icon}{label}</Link>
    </Button>
  );
}
