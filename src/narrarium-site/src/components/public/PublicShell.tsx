import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/layout/ThemeToggle";
import { PublicLanguageToggle } from "@/components/layout/PublicLanguageToggle";
import { APP_VERSION } from "@/config/version";

export function PublicShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="min-h-screen bg-background text-foreground ghost-grid">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-background/82 backdrop-blur-xl">
        <div className="mx-auto flex h-16 w-full max-w-7xl items-center justify-between px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-3">
            <span className="brand-sigil"><PenLine className="h-5 w-5" /></span>
            <span><span className="block font-serif text-lg font-semibold leading-none">{t("app.brand")}</span><span className="text-xs text-muted-foreground">{t("app.tagline")}</span></span>
          </Link>
          <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
            <Link className="hover:text-foreground" to="/docs">{t("nav.docs")}</Link>
            <Link className="hover:text-foreground" to="/mcp">{t("nav.mcp")}</Link>
            <Link className="hover:text-foreground" to="/privacy">{t("nav.privacy")}</Link>
          </nav>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <PublicLanguageToggle />
            <Button asChild variant="outline" size="sm"><Link to="/app/account-sync">{t("app.signIn")}</Link></Button>
            <Button asChild size="sm" className="hidden sm:inline-flex"><Link to="/app/books">{t("app.openApp")}</Link></Button>
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
