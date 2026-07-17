import { useState } from "react";
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
import { resolveBookToken } from "@/types/settings";
import { createOrUpdateTextFile, loadFileContent } from "@/github/githubClient";
import { stringify } from "yaml";
import { GeneratePreviewDialog } from "@/components/book/GeneratePreviewDialog";
import { proseToScript, refineProse, scriptToProse, stripFrontmatter, type PipelineSource } from "@/narrarium/pipeline";

type Stage = "drafts" | "scripts";
type GenKind = "draft" | "final" | "script";

export function ChapterStageIndexPage({ stage }: { stage: Stage }) {
  const { bookId, chapterId } = useParams<{ bookId: string; chapterId: string }>();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { settings } = useSettingsStore();
  const { branch } = useWorkingBranch(bookId);
  const { book, structure, loading, reload } = useBookStructure(bookId);
  const token = book ? resolveBookToken(book, settings) : "";
  const chapter = structure?.chapters.find((c) => c.slug === chapterId);

  const [genOpen, setGenOpen] = useState(false);
  const [genKind, setGenKind] = useState<GenKind>("draft");
  const [genText, setGenText] = useState("");
  const [genLoading, setGenLoading] = useState(false);
  const [genGw, setGenGw] = useState("");
  const [genPara, setGenPara] = useState<string>("");

  if (!book) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;
  if (loading && !structure) {
    return <div className="space-y-2">{[...Array(5)].map((_, i) => <Skeleton key={i} className="h-12" />)}</div>;
  }
  if (!chapter) {
    return <Alert variant="destructive"><AlertDescription>{t("workspace.notFound")} <Link to={`/app/books/${bookId}`} className="underline">{t("workspace.backToBook")}</Link></AlertDescription></Alert>;
  }

  const src = (): PipelineSource => ({ token, owner: book.owner, repo: book.repo, branch, settings, structure: structure!, chapter });

  function paraSlugOf(path: string) { return (path.split("/").pop() ?? "").replace(/\.md$/i, ""); }

  function startGen(kind: GenKind, _paraNumber: string, paraSlug: string) {
    // Open the preview empty; generation only starts when the user clicks Generate.
    setGenKind(kind); setGenPara(paraSlug); setGenGw(""); setGenText(""); setGenOpen(true); setGenLoading(false);
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
        setGenText(await proseToScript(src(), prose, genGw));
      } else if (kind === "draft") {
        const script = await load(p.scriptPath);
        setGenText(await scriptToProse(src(), script, genGw));
      } else {
        const draft = (await load(p.draftPath)) || (await load(p.path));
        setGenText(await refineProse(src(), draft, genGw));
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
      fm = { type: "script", id: `script:${chapter!.slug}:${genPara}`, chapter: `chapter:${chapter!.slug}`, paragraph: `paragraph:${chapter!.slug}:${genPara}`, number, title: titleText };
    } else if (genKind === "draft") {
      path = `drafts/${chapter!.slug}/${genPara}.md`;
      fm = { type: "paragraph-draft", id: `draft:paragraph:${chapter!.slug}:${genPara}`, paragraph: `paragraph:${chapter!.slug}:${genPara}`, chapter: `chapter:${chapter!.slug}`, number, title: titleText, canon: "draft" };
    } else {
      path = `${chapter!.path}/${genPara}.md`;
      fm = { type: "paragraph", id: `paragraph:${chapter!.slug}:${genPara}`, chapter: `chapter:${chapter!.slug}`, number, title: titleText };
    }
    if (genGw) fm.ghostwriter = genGw;
    const content = `---\n${stringify(fm).trim()}\n---\n\n${genText.trim()}\n`;
    try {
      await createOrUpdateTextFile(token, book!.owner, book!.repo, branch, path, content, `Generate ${path}`);
      toast({ title: t("pipeline.created", { path }) });
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
