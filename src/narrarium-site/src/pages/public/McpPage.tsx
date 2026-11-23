import { useEffect, useId } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BookMcpSection } from "@/components/public/BookMcpSection";
import { PageHero } from "@/components/public/PageHero";
import { PublicShell } from "@/components/public/PublicShell";
import { mcpTools } from "@/lib/generated-docs";
import "@/i18n/mcpBookPage";

/** The parts of the page that an address can name (`/mcp#book`), which the jump links at the top of the page point to. */
const PARTS = ["book", "packages"];

/**
 * The public /mcp page: the MCP of each book on a personal server first (what the owner uses from ChatGPT and Claude, with the real list of its tools), then
 * the local package and the public endpoint. It is a route of its own, so the tools and the texts of the book's MCP load with this page and with no other.
 */
export function McpPage() {
  const { t } = useTranslation();
  const { hash } = useLocation();
  // The page is loaded after the address, so the browser has nothing to scroll to when it opens: the part the address names is reached once it is here.
  useEffect(() => {
    const id = hash.replace(/^#/, "");
    const part = PARTS.includes(id) ? document.getElementById(id) : null;
    if (!part) return;
    part.scrollIntoView({ block: "start" });
    part.focus({ preventScroll: true });
  }, [hash]);
  const tools = mcpTools;
  const localTools = tools.filter((tool) => tool.surface === "local");
  const publicTools = tools.filter((tool) => tool.surface === "public");
  const categories = [...new Set(localTools.map((tool) => tool.category))];
  const jump = "h-auto min-h-11 whitespace-normal py-2 text-center";
  return <PublicShell><PageHero eyebrow={t("mcpPageContent.integration")} title={t("public.mcpTitle")} text={t("mcpBookPage.intro")} />
    <nav aria-label={t("mcpBookPage.jump.label")} className="mx-auto w-full max-w-7xl px-4 pb-8 sm:px-6 lg:px-8"><ul className="flex flex-wrap gap-3"><li><Button asChild variant="outline" className={jump}><a href="#book">{t("mcpBookPage.title")}</a></Button></li><li><Button asChild variant="outline" className={jump}><a href="#packages">{t("mcpBookPage.packages.title")}</a></Button></li></ul></nav>
    <BookMcpSection />
    <section id="packages" tabIndex={-1} aria-labelledby="mcp-packages-title" className="scroll-mt-20 focus:outline-none"><div className="mx-auto w-full max-w-7xl px-4 pb-4 sm:px-6 lg:px-8"><h2 id="mcp-packages-title" className="font-serif text-3xl font-semibold tracking-tight">{t("mcpBookPage.packages.title")}</h2></div><section className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-4 px-4 pb-10 sm:px-6 lg:grid-cols-2 lg:px-8"><Card><CardHeader><CardTitle>{t("mcpPageContent.localTitle")}</CardTitle><CardDescription>{t("mcpPageContent.localText")}</CardDescription></CardHeader><CardContent><pre><code>npx narrarium-mcp-server</code></pre></CardContent></Card><Card><CardHeader><CardTitle>{t("mcpPageContent.publicTitle")}</CardTitle><CardDescription>{t("mcpPageContent.publicText")}</CardDescription></CardHeader><CardContent className="space-y-2"><pre><code>https://narrarium.space/mcp</code></pre><p className="text-sm text-muted-foreground">{t("mcpPageContent.health")} <code>https://narrarium.space/health</code></p></CardContent></Card></section><section className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-6 px-4 pb-16 sm:px-6 lg:px-8">{categories.map((category) => <ToolTable key={category} title={mcpCategoryLabel(t, category)} tools={localTools.filter((tool) => tool.category === category)} />)}<ToolTable title={t("mcpPageContent.publicTools")} tools={publicTools} /></section></section></PublicShell>;
}

function ToolTable({ title, tools }: { title: string; tools: Array<{ name: string; description: string }> }) {
  const { t } = useTranslation();
  const titleId = useId();
  return <Card><CardHeader><CardTitle id={titleId}>{title}</CardTitle><CardDescription>{tools.length} {tools.length === 1 ? t("mcpPageContent.toolSingle") : t("mcpPageContent.toolPlural")}</CardDescription></CardHeader><CardContent className="overflow-x-auto"><table aria-labelledby={titleId} className="w-full min-w-[720px] text-left text-sm"><thead className="text-xs uppercase tracking-wide text-muted-foreground"><tr><th scope="col" className="border-b py-2 pr-4">{t("mcpPageContent.tool")}</th><th scope="col" className="border-b py-2">{t("mcpPageContent.description")}</th></tr></thead><tbody>{tools.map((tool) => <tr key={tool.name}><td className="border-b py-3 pr-4 align-top font-mono text-xs text-primary">{tool.name}</td><td className="border-b py-3 text-muted-foreground">{tool.description}</td></tr>)}</tbody></table></CardContent></Card>;
}

function mcpCategoryLabel(t: ReturnType<typeof useTranslation>["t"], category: string): string {
  const key = category.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return t(`mcpPageContent.categories.${key}`, { defaultValue: category });
}
