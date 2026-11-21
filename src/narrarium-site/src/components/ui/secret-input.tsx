import * as React from "react";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input, type InputProps } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SecretInputProps extends Omit<InputProps, "type"> {
  /** Reports whether the explicit copy action reached the system clipboard. */
  onCopyResult?: (copied: boolean) => void;
}

/**
 * Password-style input with an explicit reveal toggle and a copy button.
 * Copying writes only to the system clipboard, never to the synced Narrarium clipboard history.
 */
export const SecretInput = React.forwardRef<HTMLInputElement, SecretInputProps>(
  ({ className, value, onCopyResult, ...props }, ref) => {
    const { t } = useTranslation();
    const [revealed, setRevealed] = React.useState(false);
    const [copied, setCopied] = React.useState(false);
    const text = typeof value === "string" ? value : value == null ? "" : String(value);

    React.useEffect(() => {
      if (!copied) return;
      const timer = window.setTimeout(() => setCopied(false), 1500);
      return () => window.clearTimeout(timer);
    }, [copied]);

    async function copy() {
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        onCopyResult?.(true);
      } catch {
        onCopyResult?.(false);
      }
    }

    const iconButton = "inline-flex h-8 w-8 items-center justify-center rounded text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

    return (
      <div className="relative">
        <Input
          ref={ref}
          type={revealed ? "text" : "password"}
          value={value}
          autoComplete="off"
          spellCheck={false}
          className={cn("pr-[4.75rem]", revealed && "font-mono text-xs", className)}
          {...props}
        />
        <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
          <button
            type="button"
            className={iconButton}
            onClick={() => setRevealed((current) => !current)}
            disabled={!text}
            aria-pressed={revealed}
            aria-label={revealed ? t("secretInput.hide") : t("secretInput.show")}
            title={revealed ? t("secretInput.hide") : t("secretInput.show")}
          >
            {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
          <button
            type="button"
            className={iconButton}
            onClick={() => void copy()}
            disabled={!text}
            aria-label={copied ? t("secretInput.copied") : t("secretInput.copy")}
            title={copied ? t("secretInput.copied") : t("secretInput.copy")}
          >
            {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
          </button>
        </div>
      </div>
    );
  },
);
SecretInput.displayName = "SecretInput";
