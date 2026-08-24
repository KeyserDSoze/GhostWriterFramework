import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowRight, Bot, Boxes, Braces, Library, ScrollText, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PublicShell } from "@/components/public/PublicShell";
import { PUBLIC_MCP_TOOL_COUNTS } from "@/lib/generated-public-meta";

export function HomePage() {
  const { t } = useTranslation();
  return (
    <PublicShell>
      <section className="relative overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_20%_20%,hsl(var(--primary)/0.22),transparent_34%),radial-gradient(circle_at_80%_0%,hsl(var(--accent-foreground)/0.14),transparent_28%)]" />
        <div className="relative mx-auto grid w-full max-w-7xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1.02fr_0.98fr] lg:px-8 lg:py-28">
          <div className="flex flex-col justify-center">
            <Badge className="mb-5 w-fit" variant="secondary">{t("public.heroBadge")}</Badge>
            <h1 className="max-w-4xl font-serif text-5xl font-semibold tracking-tight text-foreground sm:text-6xl lg:text-7xl">{t("public.heroTitle")}</h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">{t("public.heroText")}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg"><Link to="/app/books">{t("public.openWritingApp")} <ArrowRight className="ml-2 h-4 w-4" /></Link></Button>
              <Button asChild size="lg" variant="outline"><Link to="/docs">{t("public.readDocs")}</Link></Button>
            </div>
            <div className="mt-8 grid max-w-xl grid-cols-3 gap-3 text-sm text-muted-foreground">
              <div className="rounded-2xl border bg-card/70 p-3"><strong className="block text-foreground">{t("homePage.github")}</strong>{t("homePage.booksAsRepos")}</div>
              <div className="rounded-2xl border bg-card/70 p-3"><strong className="block text-foreground">{t("homePage.drive")}</strong>{t("homePage.settingsPerUser")}</div>
              <div className="rounded-2xl border bg-card/70 p-3"><strong className="block text-foreground">{t("homePage.ai")}</strong>{t("homePage.azureOrCopilot")}</div>
            </div>
          </div>
          <div className="relative min-h-[520px]">
            <div className="absolute left-4 top-8 w-[78%] rotate-[-3deg] rounded-[2rem] border bg-card/92 p-5 shadow-2xl shadow-primary/10 backdrop-blur">
              <div className="mb-4 flex items-center justify-between"><div><p className="text-xs uppercase tracking-[0.28em] text-primary">{t("homePage.manuscript")}</p><h2 className="font-serif text-2xl font-semibold">{t("homePage.chapterSample")}</h2></div><Badge variant="outline">{t("homePage.branchSample")}</Badge></div>
              <div className="space-y-3 text-sm text-muted-foreground"><p className="rounded-2xl bg-muted/60 p-4 text-foreground">{t("homePage.proseSample")}</p><p className="rounded-2xl border border-dashed p-4">{t("homePage.aiSuggestion")}</p></div>
            </div>
            <div className="absolute bottom-14 right-0 w-[70%] rotate-[4deg] rounded-[2rem] border bg-card/95 p-5 shadow-2xl shadow-black/10"><div className="mb-3 flex items-center gap-2 text-primary"><Sparkles className="h-4 w-4" /><p className="text-xs uppercase tracking-[0.28em]">{t("homePage.pinnedDossier")}</p></div><h3 className="font-serif text-2xl font-semibold">{t("homePage.characterSample")}</h3><p className="mt-2 text-sm text-muted-foreground">{t("homePage.dossierSample")}</p></div>
            <div className="absolute bottom-0 left-2 rounded-full border bg-background/80 px-4 py-2 text-sm text-muted-foreground shadow-lg backdrop-blur">{t("homePage.pinHint")}</div>
          </div>
        </div>
      </section>
      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 pb-20 sm:px-6 md:grid-cols-2 lg:grid-cols-4 lg:px-8">
        {[
          { icon: <Library className="h-5 w-5" />, title: t("homePage.featureWorkspacesTitle"), text: t("homePage.featureWorkspacesText") },
          { icon: <Boxes className="h-5 w-5" />, title: t("homePage.featureCanonTitle"), text: t("homePage.featureCanonText") },
          { icon: <Bot className="h-5 w-5" />, title: t("homePage.featureAiTitle"), text: t("homePage.featureAiText") },
          { icon: <Braces className="h-5 w-5" />, title: t("homePage.featureMcpTitle"), text: t("homePage.featureMcpText", PUBLIC_MCP_TOOL_COUNTS) },
        ].map((feature) => <Card key={feature.title} className="bg-card/74 backdrop-blur"><CardHeader><div className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">{feature.icon}</div><CardTitle>{feature.title}</CardTitle><CardDescription>{feature.text}</CardDescription></CardHeader></Card>)}
      </section>
    </PublicShell>
  );
}

export function PrivacyPage() {
  const { t } = useTranslation();
  return <PublicShell><LegalArticle title={t("legal.privacyTitle")}><p>{t("legal.privacyIntro")}</p><h2>{t("legal.dataHandled")}</h2><p>{t("legal.dataHandledText")}</p><h2>{t("legal.thirdParty")}</h2><ul><li>{t("legal.thirdPartyGoogle")}</li><li>{t("legal.thirdPartyMicrosoft")}</li><li>{t("legal.thirdPartyGithub")}</li><li>{t("legal.thirdPartyAi")}</li></ul><h2>{t("legal.storageDeletion")}</h2><p>{t("legal.storageDeletionText")}</p></LegalArticle></PublicShell>;
}

export function TermsPage() {
  const { t } = useTranslation();
  return <PublicShell><LegalArticle title={t("legal.termsTitle")}><p>{t("legal.termsIntro")}</p><h2>{t("legal.credentials")}</h2><p>{t("legal.credentialsText")}</p><h2>{t("legal.aiProviders")}</h2><p>{t("legal.aiProvidersText")}</p><h2>{t("legal.disclaimer")}</h2><p>{t("legal.disclaimerText")}</p></LegalArticle></PublicShell>;
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return <PublicShell><section className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col items-center justify-center px-4 text-center"><ScrollText className="mb-4 h-12 w-12 text-primary" /><h1 className="font-serif text-4xl font-semibold">{t("public.notFoundTitle")}</h1><p className="mt-3 text-muted-foreground">{t("public.notFoundText")}</p><Button asChild className="mt-6"><Link to="/">{t("public.returnHome")}</Link></Button></section></PublicShell>;
}

function LegalArticle({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  return <article className="mx-auto w-full max-w-4xl px-4 py-14 sm:px-6 lg:px-8"><div className="rounded-[2rem] border bg-card/86 p-6 shadow-xl shadow-black/5 sm:p-10"><p className="mb-2 text-xs uppercase tracking-[0.24em] text-primary">{t("app.brand")}</p><h1 className="font-serif text-4xl font-semibold">{title}</h1><p className="mt-2 text-sm text-muted-foreground">{t("legal.lastUpdated")}</p><div className="doc-prose mt-8">{children}</div></div></article>;
}
