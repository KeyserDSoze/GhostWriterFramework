import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { DocsIndexContent, DocContent } from "@/pages/PublicPages";

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
  return <DocContent slug={slug} basePath="/app/docs" />;
}
