import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { marked } from "marked";
import {
  ArrowRight,
  Bot,
  Boxes,
  Braces,
  Library,
  PenLine,
  ScrollText,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { LanguageToggle } from "@/components/layout/LanguageToggle";
import { getDocBySlug, getDocGroups, getMcpTools } from "@/lib/docs";
import { APP_VERSION } from "@/config/version";

function PublicShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-background text-foreground ghost-grid">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/82 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-3">
            <span className="brand-sigil">
              <PenLine className="h-5 w-5" />
            </span>
            <span>
              <span className="block font-serif text-lg font-semibold leading-none">{t("app.brand")}</span>
              <span className="text-xs text-muted-foreground">{t("app.tagline")}</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <Link className="hover:text-foreground" to="/docs">{t("nav.docs")}</Link>
            <Link className="hover:text-foreground" to="/mcp">{t("nav.mcp")}</Link>
            <Link className="hover:text-foreground" to="/privacy">{t("nav.privacy")}</Link>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <LanguageToggle />
            <Button asChild variant="outline" size="sm">
              <Link to="/login">{t("app.signIn")}</Link>
            </Button>
            <Button asChild size="sm" className="hidden sm:inline-flex">
              <Link to="/app/books">{t("app.openApp")}</Link>
            </Button>
          </div>
        </div>
      </header>
      <main>{children}</main>
      <footer className="border-t border-border/60 bg-background/80">
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <p>{t("public.footer")}</p>
          <div className="flex items-center gap-4">
            <Link to="/terms" className="hover:text-foreground">{t("nav.terms")}</Link>
            <Link to="/privacy" className="hover:text-foreground">{t("nav.privacy")}</Link>
            <Link to="/docs" className="hover:text-foreground">{t("nav.docs")}</Link>
            <span className="font-mono text-xs">v{APP_VERSION}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

export function HomePage() {
  const { t } = useTranslation();
  const tools = getMcpTools();
  const localToolCount = tools.filter((tool) => tool.surface === "local").length;
  const publicToolCount = tools.filter((tool) => tool.surface === "public").length;

  return (
    <PublicShell>
      <section className="relative overflow-hidden">
        <div className="absolute inset-x-0 top-0 h-72 bg-[radial-gradient(circle_at_20%_20%,hsl(var(--primary)/0.22),transparent_34%),radial-gradient(circle_at_80%_0%,hsl(var(--accent-foreground)/0.14),transparent_28%)]" />
        <div className="relative mx-auto grid w-full max-w-7xl gap-12 px-4 py-20 sm:px-6 lg:grid-cols-[1.02fr_0.98fr] lg:px-8 lg:py-28">
          <div className="flex flex-col justify-center">
            <Badge className="mb-5 w-fit" variant="secondary">{t("public.heroBadge")}</Badge>
            <h1 className="max-w-4xl font-serif text-5xl font-semibold tracking-tight text-foreground sm:text-6xl lg:text-7xl">
              {t("public.heroTitle")}
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground">
              {t("public.heroText")}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Button asChild size="lg">
                <Link to="/app/books">{t("public.openWritingApp")} <ArrowRight className="ml-2 h-4 w-4" /></Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/docs">{t("public.readDocs")}</Link>
              </Button>
            </div>
            <div className="mt-8 grid max-w-xl grid-cols-3 gap-3 text-sm text-muted-foreground">
              <div className="rounded-2xl border bg-card/70 p-3"><strong className="block text-foreground">{t("homePage.github")}</strong>{t("homePage.booksAsRepos")}</div>
              <div className="rounded-2xl border bg-card/70 p-3"><strong className="block text-foreground">{t("homePage.drive")}</strong>{t("homePage.settingsPerUser")}</div>
              <div className="rounded-2xl border bg-card/70 p-3"><strong className="block text-foreground">{t("homePage.ai")}</strong>{t("homePage.azureOrCopilot")}</div>
            </div>
          </div>
          <div className="relative min-h-[520px]">
            <div className="absolute left-4 top-8 w-[78%] rotate-[-3deg] rounded-[2rem] border bg-card/92 p-5 shadow-2xl shadow-primary/10 backdrop-blur">
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.28em] text-primary">{t("homePage.manuscript")}</p>
                  <h2 className="font-serif text-2xl font-semibold">{t("homePage.chapterSample")}</h2>
                </div>
                <Badge variant="outline">{t("homePage.branchSample")}</Badge>
              </div>
              <div className="space-y-3 text-sm text-muted-foreground">
                <p className="rounded-2xl bg-muted/60 p-4 text-foreground">{t("homePage.proseSample")}</p>
                <p className="rounded-2xl border border-dashed p-4">{t("homePage.aiSuggestion")}</p>
              </div>
            </div>
            <div className="absolute bottom-14 right-0 w-[70%] rotate-[4deg] rounded-[2rem] border bg-card/95 p-5 shadow-2xl shadow-black/10">
              <div className="mb-3 flex items-center gap-2 text-primary">
                <Sparkles className="h-4 w-4" />
                <p className="text-xs uppercase tracking-[0.28em]">{t("homePage.pinnedDossier")}</p>
              </div>
              <h3 className="font-serif text-2xl font-semibold">{t("homePage.characterSample")}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{t("homePage.dossierSample")}</p>
            </div>
            <div className="absolute bottom-0 left-2 rounded-full border bg-background/80 px-4 py-2 text-sm text-muted-foreground shadow-lg backdrop-blur">
              {t("homePage.pinHint")}
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 pb-20 sm:px-6 md:grid-cols-2 lg:grid-cols-4 lg:px-8">
        {[
          { icon: <Library className="h-5 w-5" />, title: t("homePage.featureWorkspacesTitle"), text: t("homePage.featureWorkspacesText") },
          { icon: <Boxes className="h-5 w-5" />, title: t("homePage.featureCanonTitle"), text: t("homePage.featureCanonText") },
          { icon: <Bot className="h-5 w-5" />, title: t("homePage.featureAiTitle"), text: t("homePage.featureAiText") },
          { icon: <Braces className="h-5 w-5" />, title: t("homePage.featureMcpTitle"), text: t("homePage.featureMcpText", { local: localToolCount, public: publicToolCount }) },
        ].map((feature) => (
          <Card key={feature.title} className="bg-card/74 backdrop-blur">
            <CardHeader>
              <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">{feature.icon}</div>
              <CardTitle>{feature.title}</CardTitle>
              <CardDescription>{feature.text}</CardDescription>
            </CardHeader>
          </Card>
        ))}
      </section>
    </PublicShell>
  );
}

export function DocsIndexPage() {
  const { t } = useTranslation();
  const groups = getDocGroups();
  return (
    <PublicShell>
      <PageHero eyebrow={t("docsPage.documentation")} title={t("public.docsTitle")} text={t("public.docsText")} />
      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 pb-16 sm:px-6 lg:grid-cols-3 lg:px-8">
        {groups.map((group) => (
          <Card key={group.key} className="bg-card/80">
            <CardHeader>
              <CardTitle>{group.label}</CardTitle>
              <CardDescription>{group.docs.length} {group.docs.length === 1 ? t("docsPage.page") : t("docsPage.pages")}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {group.docs.map((doc) => (
                <Link key={doc.href} className="rounded-xl border bg-background/60 p-3 text-sm transition hover:border-primary/50 hover:bg-accent" to={doc.href}>
                  <span className="font-medium">{doc.title}</span>
                  <span className="mt-1 block text-xs text-muted-foreground">{doc.sourcePath}</span>
                </Link>
              ))}
            </CardContent>
          </Card>
        ))}
      </section>
    </PublicShell>
  );
}

export function DocPage() {
  const { t } = useTranslation();
  const params = useParams();
  const slug = params["*"]?.replace(/^\/+|\/+$/g, "") || undefined;
  const doc = getDocBySlug(slug);

  if (!doc) return <NotFoundPage />;

  const html = useMarkdownHtml(doc.markdown);
  return (
    <PublicShell>
      <section className="mx-auto grid w-full max-w-7xl gap-6 px-4 py-10 sm:px-6 lg:grid-cols-[280px_minmax(0,1fr)] lg:px-8">
        <aside className="hidden lg:block">
          <div className="sticky top-24 rounded-3xl border bg-card/80 p-4">
            <p className="mb-3 text-xs uppercase tracking-[0.22em] text-muted-foreground">{t("docsPage.docs")}</p>
            <nav className="grid gap-1">
              {getDocGroups().flatMap((group) => group.docs).map((entry) => (
                <Link key={entry.slug} to={entry.href} className={entry.slug === doc.slug ? "rounded-xl bg-primary px-3 py-2 text-sm text-primary-foreground" : "rounded-xl px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"}>
                  {entry.title}
                </Link>
              ))}
            </nav>
          </div>
        </aside>
        <article className="rounded-[2rem] border bg-card/86 p-5 shadow-xl shadow-black/5 sm:p-8">
          <div className="mb-8 border-b pb-6">
            <Badge variant="secondary">{doc.groupLabel}</Badge>
            <h1 className="mt-4 font-serif text-4xl font-semibold tracking-tight sm:text-5xl">{doc.title}</h1>
            <p className="mt-3 max-w-3xl text-muted-foreground">{doc.summary}</p>
            <p className="mt-3 text-xs text-muted-foreground">{t("docsPage.source")} <code>{doc.sourcePath}</code></p>
          </div>
          <div className="doc-prose" dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      </section>
    </PublicShell>
  );
}

export function McpPage() {
  const { t } = useTranslation();
  const tools = getMcpTools();
  const localTools = tools.filter((tool) => tool.surface === "local");
  const publicTools = tools.filter((tool) => tool.surface === "public");
  const localCategories = [...new Set(localTools.map((tool) => tool.category))];
  const publicMcpUrl = "https://narrarium.space/mcp";
  const publicHealthUrl = "https://narrarium.space/health";

  return (
    <PublicShell>
      <PageHero eyebrow={t("mcpPageContent.integration")} title={t("public.mcpTitle")} text={t("public.mcpText")} />
      <section className="mx-auto grid w-full max-w-7xl gap-4 px-4 pb-10 sm:px-6 lg:grid-cols-2 lg:px-8">
        <Card>
          <CardHeader>
            <CardTitle>{t("mcpPageContent.localTitle")}</CardTitle>
            <CardDescription>{t("mcpPageContent.localText")}</CardDescription>
          </CardHeader>
          <CardContent><pre><code>npx narrarium-mcp-server</code></pre></CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("mcpPageContent.publicTitle")}</CardTitle>
            <CardDescription>{t("mcpPageContent.publicText")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2"><pre><code>{publicMcpUrl}</code></pre><p className="text-sm text-muted-foreground">{t("mcpPageContent.health")} <code>{publicHealthUrl}</code></p></CardContent>
        </Card>
      </section>
      <section className="mx-auto grid w-full max-w-7xl gap-6 px-4 pb-16 sm:px-6 lg:px-8">
        {localCategories.map((category) => (
          <ToolTable key={category} title={category} tools={localTools.filter((tool) => tool.category === category)} />
        ))}
        <ToolTable title={t("mcpPageContent.publicTools")} tools={publicTools} />
      </section>
    </PublicShell>
  );
}

export function PrivacyPage() {
  const { t } = useTranslation();
  return (
    <PublicShell>
      <LegalArticle title={t("legal.privacyTitle")}>
        <p>{t("legal.privacyIntro")}</p>
        <h2>{t("legal.dataHandled")}</h2>
        <p>{t("legal.dataHandledText")}</p>
        <h2>{t("legal.thirdParty")}</h2>
        <ul>
          <li>{t("legal.thirdPartyGoogle")}</li>
          <li>{t("legal.thirdPartyMicrosoft")}</li>
          <li>{t("legal.thirdPartyGithub")}</li>
          <li>{t("legal.thirdPartyAi")}</li>
        </ul>
        <h2>{t("legal.storageDeletion")}</h2>
        <p>{t("legal.storageDeletionText")}</p>
      </LegalArticle>
    </PublicShell>
  );
}

export function TermsPage() {
  const { t } = useTranslation();
  return (
    <PublicShell>
      <LegalArticle title={t("legal.termsTitle")}>
        <p>{t("legal.termsIntro")}</p>
        <h2>{t("legal.credentials")}</h2>
        <p>{t("legal.credentialsText")}</p>
        <h2>{t("legal.aiProviders")}</h2>
        <p>{t("legal.aiProvidersText")}</p>
        <h2>{t("legal.disclaimer")}</h2>
        <p>{t("legal.disclaimerText")}</p>
      </LegalArticle>
    </PublicShell>
  );
}

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <PublicShell>
      <section className="mx-auto flex min-h-[60vh] w-full max-w-3xl flex-col items-center justify-center px-4 text-center">
        <ScrollText className="mb-4 h-12 w-12 text-primary" />
        <h1 className="font-serif text-4xl font-semibold">{t("public.notFoundTitle")}</h1>
        <p className="mt-3 text-muted-foreground">{t("public.notFoundText")}</p>
        <Button asChild className="mt-6"><Link to="/">{t("public.returnHome")}</Link></Button>
      </section>
    </PublicShell>
  );
}

function PageHero({ eyebrow, title, text }: { eyebrow: string; title: string; text: string }) {
  return (
    <section className="mx-auto w-full max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
      <Badge variant="secondary">{eyebrow}</Badge>
      <h1 className="mt-4 max-w-4xl font-serif text-4xl font-semibold tracking-tight sm:text-5xl">{title}</h1>
      <p className="mt-4 max-w-3xl text-lg leading-8 text-muted-foreground">{text}</p>
    </section>
  );
}

function ToolTable({ title, tools }: { title: string; tools: Array<{ name: string; description: string }> }) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{tools.length} {t("mcpPageContent.toolSuffix")}{tools.length === 1 ? "" : "s"}</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted-foreground">
            <tr><th className="border-b py-2 pr-4">{t("mcpPageContent.tool")}</th><th className="border-b py-2">{t("mcpPageContent.description")}</th></tr>
          </thead>
          <tbody>
            {tools.map((tool) => (
              <tr key={tool.name}>
                <td className="border-b py-3 pr-4 align-top font-mono text-xs text-primary">{tool.name}</td>
                <td className="border-b py-3 text-muted-foreground">{tool.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

function LegalArticle({ title, children }: { title: string; children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <article className="mx-auto w-full max-w-4xl px-4 py-14 sm:px-6 lg:px-8">
      <div className="rounded-[2rem] border bg-card/86 p-6 shadow-xl shadow-black/5 sm:p-10">
        <p className="mb-2 text-xs uppercase tracking-[0.24em] text-primary">{t("app.brand")}</p>
        <h1 className="font-serif text-4xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">{t("legal.lastUpdated")}</p>
        <div className="doc-prose mt-8">{children}</div>
      </div>
    </article>
  );
}

function useMarkdownHtml(markdown: string): string {
  return useMemo(() => marked.parse(markdown, { async: false }) as string, [markdown]);
}
