import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PublicShell } from "@/components/public/PublicShell";
import { getDocBySlug, getDocGroups, getMcpTools, localizedDoc, normalizeDocLang } from "@/lib/docs";
import { renderRepositoryMarkdownHtml } from "@/markdown/safeMarkdown";

export function DocsIndexContent({ basePath = "/docs" }: { basePath?: string }) {
  const { t, i18n } = useTranslation();
  const lang = normalizeDocLang(i18n.language);
  return <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 pb-16 sm:px-6 lg:grid-cols-3 lg:px-8">{getDocGroups().map((group) => <Card key={group.key} className="bg-card/80"><CardHeader><CardTitle>{group.label}</CardTitle><CardDescription>{group.docs.length} {group.docs.length === 1 ? t("docsPage.page") : t("docsPage.pages")}</CardDescription></CardHeader><CardContent className="grid gap-2">{group.docs.map((doc) => { const localized = localizedDoc(doc, lang); return <Link key={doc.slug} className="rounded-xl border bg-background/60 p-3 text-sm transition hover:border-primary/50 hover:bg-accent" to={`${basePath}/${doc.slug}`}><span className="font-medium">{localized.title}</span><span className="mt-1 block text-xs text-muted-foreground">{localized.summary}</span></Link>; })}</CardContent></Card>)}</section>;
}

export function DocsIndexPage() {
  const { t } = useTranslation();
  return <PublicShell><PageHero eyebrow={t("docsPage.documentation")} title={t("public.docsTitle")} text={t("public.docsText")} /><DocsIndexContent /></PublicShell>;
}

export function DocPage() {
  const params = useParams();
  const slug = params["*"]?.replace(/^\/+|\/+$/g, "") || undefined;
  const { i18n, t } = useTranslation();
  const doc = getDocBySlug(slug);
  if (!doc) return <PublicShell><div className="mx-auto max-w-3xl p-8 text-muted-foreground">{t("public.notFoundText")}</div></PublicShell>;
  const localized = localizedDoc(doc, normalizeDocLang(i18n.language));
  return <PublicShell><section className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-10 sm:px-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:px-8"><aside className="hidden lg:block"><div className="sticky top-24 rounded-3xl border bg-card/80 p-4"><p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted-foreground">{t("docsPage.docs")}</p><nav className="grid gap-1">{getDocGroups().flatMap((group) => group.docs).map((entry) => <Link key={entry.slug} to={`/docs/${entry.slug}`} className={entry.slug === doc.slug ? "rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground" : "rounded-xl px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"}>{localizedDoc(entry, normalizeDocLang(i18n.language)).title}</Link>)}</nav></div></aside><article className="rounded-[2rem] border bg-card/86 p-5 shadow-xl shadow-black/5 sm:p-8"><div className="mb-8 border-b pb-6"><Badge variant="secondary">{doc.groupLabel}</Badge><h1 className="mt-4 font-serif text-4xl font-semibold tracking-tight sm:text-5xl">{localized.title}</h1><p className="mt-3 max-w-3xl text-muted-foreground">{localized.summary}</p></div><div className="doc-prose" dangerouslySetInnerHTML={{ __html: renderRepositoryMarkdownHtml(localized.markdown) }} /></article></section></PublicShell>;
}

export function McpPage() {
  const { t } = useTranslation();
  const tools = getMcpTools();
  const localTools = tools.filter((tool) => tool.surface === "local");
  const publicTools = tools.filter((tool) => tool.surface === "public");
  const categories = [...new Set(localTools.map((tool) => tool.category))];
  return <PublicShell><PageHero eyebrow={t("mcpPageContent.integration")} title={t("public.mcpTitle")} text={t("public.mcpText")} /><section className="mx-auto grid w-full max-w-7xl gap-4 px-4 pb-10 sm:px-6 lg:grid-cols-2 lg:px-8"><Card><CardHeader><CardTitle>{t("mcpPageContent.localTitle")}</CardTitle><CardDescription>{t("mcpPageContent.localText")}</CardDescription></CardHeader><CardContent><pre><code>npx narrarium-mcp-server</code></pre></CardContent></Card><Card><CardHeader><CardTitle>{t("mcpPageContent.publicTitle")}</CardTitle><CardDescription>{t("mcpPageContent.publicText")}</CardDescription></CardHeader><CardContent className="space-y-2"><pre><code>https://narrarium.space/mcp</code></pre><p className="text-sm text-muted-foreground">{t("mcpPageContent.health")} <code>https://narrarium.space/health</code></p></CardContent></Card></section><section className="mx-auto grid w-full max-w-7xl gap-6 px-4 pb-16 sm:px-6 lg:px-8">{categories.map((category) => <ToolTable key={category} title={mcpCategoryLabel(t, category)} tools={localTools.filter((tool) => tool.category === category)} />)}<ToolTable title={t("mcpPageContent.publicTools")} tools={publicTools} /></section></PublicShell>;
}

function PageHero({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return <section className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 lg:px-8"><Badge variant="secondary">{eyebrow}</Badge><h1 className="mt-4 max-w-4xl font-serif text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1><p className="mt-4 max-w-3xl text-lg leading-8 text-muted-foreground">{text}</p></section>;
}

function ToolTable({ title, tools }: { title: string; tools: Array<{ name: string; description: string }> }) {
  const { t } = useTranslation();
  return <Card><CardHeader><CardTitle>{title}</CardTitle><CardDescription>{tools.length} {tools.length === 1 ? t("mcpPageContent.toolSingle") : t("mcpPageContent.toolPlural")}</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table className="w-full min-w-[720px] text-left text-sm"><thead className="text-xs uppercase tracking-wide text-muted-foreground"><tr><th className="border-b py-2 pr-4">{t("mcpPageContent.tool")}</th><th className="border-b py-2">{t("mcpPageContent.description")}</th></tr></thead><tbody>{tools.map((tool) => <tr key={tool.name}><td className="border-b py-3 pr-4 align-top font-mono text-xs text-primary">{tool.name}</td><td className="border-b py-3 text-muted-foreground">{tool.description}</td></tr>)}</tbody></table></CardContent></Card>;
}

function mcpCategoryLabel(t: ReturnType<typeof useTranslation>["t"], category: string): string {
  const key = category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return t(`mcpPageContent.categories.${key}`, { defaultValue: category });
}
