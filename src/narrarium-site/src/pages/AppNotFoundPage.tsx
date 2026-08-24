import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";

export function AppNotFoundPage() {
  const { t } = useTranslation();
  return (
    <section className="mx-auto flex min-h-[55vh] max-w-xl flex-col items-center justify-center text-center">
      <h1 className="font-serif text-3xl font-semibold">{t("public.notFoundTitle")}</h1>
      <p className="mt-3 text-sm text-muted-foreground">{t("public.notFoundText")}</p>
      <Button asChild className="mt-6"><Link to="/app/books">{t("nav.books")}</Link></Button>
    </section>
  );
}
