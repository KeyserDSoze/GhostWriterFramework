import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DocsIndexContent } from "@/pages/PublicPages";
import { getDocBySlug, localizedDoc, normalizeDocLang } from "@/lib/docs";
import { renderAssistantMarkdownHtml } from "@/assistant/chatArtifacts";

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
  const params = useParams();
  const slug = params["*"]?.replace(/^\/+|\/+$/g, "") || undefined;
  const { i18n, t } = useTranslation();
  const doc = getDocBySlug(slug);
  if (!doc) return <div className="rounded-2xl border border-dashed p-6 text-sm text-muted-foreground">{t("public.notFoundText")}</div>;
  const localized = localizedDoc(doc, normalizeDocLang(i18n.language));
  return (
    <article className="mx-auto w-full max-w-4xl rounded-3xl border bg-card p-5 shadow-sm sm:p-8">
      <div className="mb-8 border-b pb-6">
        <p className="text-xs uppercase tracking-[0.2em] text-primary">{t("docsPage.documentation")}</p>
        <h1 className="mt-3 font-serif text-3xl font-semibold sm:text-4xl">{localized.title}</h1>
        <p className="mt-3 text-muted-foreground">{localized.summary}</p>
      </div>
      <div className="doc-prose max-w-none" dangerouslySetInnerHTML={{ __html: renderAssistantMarkdownHtml(localized.markdown) }} />
    </article>
  );
}
