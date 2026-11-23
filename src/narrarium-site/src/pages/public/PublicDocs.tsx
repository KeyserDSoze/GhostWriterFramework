import { useRef } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DocContent, useDocumentPage } from "@/components/docs/DocContent";
import { PageHero } from "@/components/public/PageHero";
import { PublicShell } from "@/components/public/PublicShell";
import { getDocBySlug, getDocGroups, localizedDoc, normalizeDocLang, withGeneratedDocs, type DocEntry } from "@/lib/docs";
import { docEntries } from "@/lib/generated-docs";
import { renderRepositoryMarkdownHtml } from "@/markdown/safeMarkdown";

const docs = withGeneratedDocs(docEntries);

export function DocsIndexContent({ basePath = "/docs" }: { basePath?: string }) {
  const { t, i18n } = useTranslation();
  const lang = normalizeDocLang(i18n.language);
  return <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 pb-16 sm:px-6 lg:grid-cols-3 lg:px-8">{getDocGroups(docs).map((group) => <Card key={group.key} className="bg-card/80"><CardHeader><CardTitle>{group.label}</CardTitle><CardDescription>{group.docs.length} {group.docs.length === 1 ? t("docsPage.page") : t("docsPage.pages")}</CardDescription></CardHeader><CardContent className="grid gap-2">{group.docs.map((doc) => { const localized = localizedDoc(doc, lang); return <Link key={doc.slug} className="rounded-xl border bg-background/60 p-3 text-sm transition hover:border-primary/50 hover:bg-accent" to={`${basePath}/${doc.slug}`}><span className="font-medium">{localized.title}</span><span className="mt-1 block text-xs text-muted-foreground">{localized.summary}</span></Link>; })}</CardContent></Card>)}</section>;
}

export function DocsIndexPage() {
  const { t } = useTranslation();
  return <PublicShell><PageHero eyebrow={t("docsPage.documentation")} title={t("public.docsTitle")} text={t("public.docsText")} /><DocsIndexContent /></PublicShell>;
}

export function DocPage() {
  const slug = useParams().docSlug;
  const { t } = useTranslation();
  const doc = getDocBySlug(slug, docs);
  if (!doc) return <PublicShell><div className="mx-auto max-w-3xl p-8 text-muted-foreground">{t("public.notFoundText")}</div></PublicShell>;
  return <PublicShell><DocArticle doc={doc} /></PublicShell>;
}

function DocArticle({ doc }: { doc: DocEntry }) {
  const { i18n, t } = useTranslation();
  const lang = normalizeDocLang(i18n.language);
  const localized = localizedDoc(doc, lang);
  const title = useRef<HTMLHeadingElement>(null);
  useDocumentPage(doc.slug, localized.title, title);
  return <section className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-10 sm:px-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:px-8"><aside className="hidden lg:block"><div className="sticky top-24 rounded-3xl border bg-card/80 p-4"><p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted-foreground">{t("docsPage.docs")}</p><nav className="grid gap-1">{getDocGroups(docs).flatMap((group) => group.docs).map((entry) => <Link key={entry.slug} to={`/docs/${entry.slug}`} aria-current={entry.slug === doc.slug ? "page" : undefined} className={entry.slug === doc.slug ? "rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground" : "rounded-xl px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"}>{localizedDoc(entry, lang).title}</Link>)}</nav></div></aside><article className="rounded-[2rem] border bg-card/86 p-5 shadow-xl shadow-black/5 sm:p-8"><div className="mb-8 border-b pb-6"><Badge variant="secondary">{doc.groupLabel}</Badge><h1 ref={title} tabIndex={-1} className="mt-4 font-serif text-4xl font-semibold tracking-tight outline-none sm:text-5xl">{localized.title}</h1><p className="mt-3 max-w-3xl text-muted-foreground">{localized.summary}</p></div><DocContent entry={doc} lang={lang} render={renderRepositoryMarkdownHtml} className="doc-prose" /></article></section>;
}
