import { useRef } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DocsIndexContent } from "@/pages/public/PublicDocs";
import { DocContent, useDocumentPage } from "@/components/docs/DocContent";
import { getDocBySlug, localizedDoc, normalizeDocLang, withGeneratedDocs, type DocEntry } from "@/lib/docs";
import { docEntries } from "@/lib/generated-docs";
import { renderAssistantMarkdownHtml } from "@/assistant/chatArtifacts";

const docs = withGeneratedDocs(docEntries);

export function AppDocsIndexPage() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-serif text-2xl font-semibold">{t("public.docsTitle")}</h1>
        <p className="text-sm text-muted-foreground">{t("public.docsText")}</p>
      </div>
      <DocsIndexContent basePath="/app/docs" />
    </div>
  );
}

export function AppDocPage() {
  const slug = useParams().docSlug;
  const { t } = useTranslation();
  const doc = getDocBySlug(slug, docs);
  if (!doc) return <div className="rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">{t("public.notFoundText")}</div>;
  return <AppDocArticle doc={doc} />;
}

function AppDocArticle({ doc }: { doc: DocEntry }) {
  const { i18n, t } = useTranslation();
  const lang = normalizeDocLang(i18n.language);
  const localized = localizedDoc(doc, lang);
  const title = useRef<HTMLHeadingElement>(null);
  useDocumentPage(doc.slug, localized.title, title);
  return (
    <article className="mx-auto w-full max-w-4xl rounded-3xl border border-layer bg-card p-5 shadow-sm sm:p-8">
      <div className="mb-8 border-b pb-6">
        <p className="text-xs uppercase tracking-[0.2em] text-primary">{t("docsPage.documentation")}</p>
        <h1 ref={title} tabIndex={-1} className="mt-3 font-serif text-3xl font-semibold outline-none sm:text-4xl">{localized.title}</h1>
        <p className="mt-3 text-muted-foreground">{localized.summary}</p>
      </div>
      <DocContent entry={doc} lang={lang} render={renderAssistantMarkdownHtml} className="doc-prose max-w-none" />
    </article>
  );
}
