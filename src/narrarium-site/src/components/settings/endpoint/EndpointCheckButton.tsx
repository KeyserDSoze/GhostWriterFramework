import { useTranslation } from "react-i18next";
import { Activity, Loader2 } from "lucide-react";
import "@/i18n/endpoint";
import { Button } from "@/components/ui/button";

/**
 * «Check the connection»: the words on the button are the same everywhere and its name says which integration it asks, beginning with those words. While a check is on its way the
 * button is not disabled, so the keyboard stays where it was (a disabled button throws the focus away); it says so with `aria-disabled`, and the press does nothing.
 */
export function EndpointCheckButton({ name, checking, onCheck, describedBy, disabled = false }: { name: string; checking: boolean; onCheck: () => void; describedBy?: string; disabled?: boolean }) {
  const { t } = useTranslation();
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={disabled}
      aria-label={t("endpoint.checkNamed", { name })}
      aria-disabled={checking || undefined}
      aria-describedby={describedBy}
      className="h-auto whitespace-normal py-1.5 text-left aria-disabled:opacity-60"
      onClick={onCheck}
    >
      {checking ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Activity className="mr-1 h-3.5 w-3.5" aria-hidden="true" />}
      {t("endpoint.check")}
    </Button>
  );
}
