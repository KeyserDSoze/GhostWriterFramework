import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, MIN_IDLE_TIMEOUT_MS, MIN_REQUEST_TIMEOUT_MS } from "narrarium-engine";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEFAULT_PROVIDER_TIMEOUT_MS } from "@/assistant/executionLimits";
import type { AIIntegration } from "@/types/settings";

/** The idle timeout the engine will use for what was typed: a whole number of milliseconds between its limits. */
const keepIdleTimeout = (typed: number) => Math.min(MAX_IDLE_TIMEOUT_MS, Math.max(MIN_IDLE_TIMEOUT_MS, Math.round(typed)));
/** The provider timeout as the author wrote it: the engine raises a low one when it calls, and the settings keep what was written. */
const keepProviderTimeout = (typed: number) => Math.max(0, Math.floor(typed));

interface NumberFieldProps {
  label: string;
  hint: string;
  value: number | undefined;
  /** What an empty field means, shown in it. */
  placeholder: string;
  min: number;
  max?: number;
  /** The value that is kept for a number that was typed. An empty field keeps no value: the default applies. */
  keep: (typed: number) => number;
  onChange: (value: number | undefined) => void;
}

function NumberField({ label, hint, value, placeholder, min, max, keep, onChange }: NumberFieldProps) {
  const id = useId();
  // What is being typed stays in the field until it is left: a value that is kept within limits would otherwise replace "4" with
  // the minimum before the author has typed "45000". It is shown only while it is what is kept, so a change from outside wins.
  const [typing, setTyping] = useState<{ raw: string; kept: number | undefined } | null>(null);
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step="1"
        value={typing && typing.kept === value ? typing.raw : value ?? ""}
        placeholder={placeholder}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          const raw = event.target.value;
          const typed = raw.trim() === "" ? Number.NaN : Number(raw);
          const kept = Number.isFinite(typed) ? keep(typed) : undefined;
          setTyping({ raw, kept });
          onChange(kept);
        }}
        onBlur={() => setTyping(null)}
        className="h-8 text-sm"
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}

/** Anything but "off" is Automatic, as the engine reads it. Automatic is stored as no value at all, so a settings file stays as an older app wrote it. */
function StreamingField({ value, onChange }: { value: AIIntegration["streamMode"]; onChange: (value: AIIntegration["streamMode"]) => void }) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <div className="grid gap-1">
      <Label htmlFor={id} className="text-xs">{t("settings.streamMode")}</Label>
      <Select value={value === "off" ? "off" : "auto"} onValueChange={(next) => onChange(next === "off" ? "off" : undefined)}>
        <SelectTrigger id={id} aria-describedby={`${id}-hint`} className="h-8 text-sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="auto">{t("settings.streamModeAuto")}</SelectItem>
          <SelectItem value="off">{t("settings.streamModeOff")}</SelectItem>
        </SelectContent>
      </Select>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">{t("settings.streamModeHint")}</p>
    </div>
  );
}

/**
 * How long a slow model is given, and whether its replies stream, for one integration: the provider timeout, the idle timeout and
 * Streaming. They sit in the grid of the integration card (this renders its cells), and are not for Microsoft 365 Copilot.
 * The figures in the hints are the engine's own, so a hint never says something the engine does not do.
 */
export function IntegrationRequestFields({ integration, onChange }: { integration: Pick<AIIntegration, "requestTimeoutMs" | "idleTimeoutMs" | "streamMode">; onChange: (patch: Partial<AIIntegration>) => void }) {
  const { t, i18n } = useTranslation();
  const format = (value: number) => new Intl.NumberFormat(i18n.resolvedLanguage ?? i18n.language).format(value);
  const idleHint = t("settings.idleTimeoutHint", { min: format(MIN_IDLE_TIMEOUT_MS), max: format(MAX_IDLE_TIMEOUT_MS), empty: format(DEFAULT_IDLE_TIMEOUT_MS), minutes: DEFAULT_IDLE_TIMEOUT_MS / 60_000 });
  return (
    <>
      <NumberField
        label={t("settings.requestTimeoutMs")}
        hint={t("settings.requestTimeoutHint", { min: format(MIN_REQUEST_TIMEOUT_MS), empty: format(DEFAULT_REQUEST_TIMEOUT_MS), minutes: DEFAULT_REQUEST_TIMEOUT_MS / 60_000, whole: format(DEFAULT_PROVIDER_TIMEOUT_MS) })}
        value={integration.requestTimeoutMs}
        placeholder={String(DEFAULT_REQUEST_TIMEOUT_MS)}
        min={0}
        keep={keepProviderTimeout}
        onChange={(requestTimeoutMs) => onChange({ requestTimeoutMs })}
      />
      <NumberField
        label={t("settings.idleTimeoutMs")}
        hint={integration.streamMode === "off" ? `${idleHint} ${t("settings.idleTimeoutOffNote")}` : idleHint}
        value={integration.idleTimeoutMs}
        placeholder={String(DEFAULT_IDLE_TIMEOUT_MS)}
        min={MIN_IDLE_TIMEOUT_MS}
        max={MAX_IDLE_TIMEOUT_MS}
        keep={keepIdleTimeout}
        onChange={(idleTimeoutMs) => onChange({ idleTimeoutMs })}
      />
      <StreamingField value={integration.streamMode} onChange={(streamMode) => onChange({ streamMode })} />
    </>
  );
}
