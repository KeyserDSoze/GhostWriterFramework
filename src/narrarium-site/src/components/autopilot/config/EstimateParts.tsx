import { type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Info, XCircle } from "lucide-react";
import type { AiRuntimeConfig, EstimateCapability, EstimateResult } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { ROLES, roleOf, type EstimateBasis, type RoleId, type WarningGroup } from "@/autopilot/runEstimate";
import type { Range } from "@/autopilot/runEstimateFormat";
import { cn } from "@/lib/utils";

/** The parts of the estimate of a run that its two places share: the one in the setup form (the preview) and the one at the end of the plan that waits for the author. */

export function useLocale(): string {
  const { i18n } = useTranslation();
  return i18n.resolvedLanguage || i18n.language || "en";
}

export function listOf(items: readonly string[]): string {
  return items.join(", ");
}

/** A name the author chose (a model) inside a sentence of ours: isolated, so that a name in a script written the other way round does not reorder the words around it. */
export function isolate(name: string): string {
  return `\u2068${name}\u2069`;
}

export function uniqueRoles(capabilities: readonly EstimateCapability[]): RoleId[] {
  return [...new Set(capabilities.map(roleOf))];
}

/** The roles an author knows, by their names in the language of the page. */
export function useRoleNames(): { roleName: (role: RoleId) => string; roleNames: (capabilities: readonly EstimateCapability[]) => string } {
  const { t } = useTranslation();
  const roleName = (role: RoleId) => t(`autopilot.estimate.roles.${role}`);
  return { roleName, roleNames: (capabilities) => listOf(uniqueRoles(capabilities).map(roleName)) };
}

/**
 * Why the cost or the time of an estimate is not known, in words (`null` for the one that is): which models have no price, which roles have no measured speed yet, or that no model
 * is set for them at all (there is nothing to price and nothing to time, and a missing price is not what is wrong). A place that says the missing models in a problem of its own
 * under the figures asks for `quiet`: it has no use for the same words twice.
 */
export function useWhyUnknown(estimate: EstimateResult, basis: EstimateBasis, quiet = false): { cost: string | null; minutes: string | null } {
  const { t } = useTranslation();
  const { roleNames } = useRoleNames();
  const unpricedModels = [...new Set(estimate.unpriced.flatMap((capability) => estimate.capabilities[capability].model ?? []))];
  const withoutModel = estimate.unmeasured.length > 0 && estimate.unmeasured.every((capability) => estimate.capabilities[capability].model === null);
  const noModelWhy = (capabilities: EstimateResult["unpriced"]) => (quiet ? null : t("autopilot.estimate.noModelWhy", { roles: roleNames(capabilities) }));
  return {
    cost: estimate.cost
      ? null
      : unpricedModels.length === 0
        ? noModelWhy(estimate.unpriced)
        : t("autopilot.estimate.costWhy", { models: listOf(unpricedModels.map(isolate)), roles: roleNames(estimate.unpriced) }),
    minutes: estimate.minutes
      ? null
      : withoutModel
        ? noModelWhy(estimate.unmeasured)
        : basis.hasRun ? t("autopilot.estimate.minutesWhyRoles", { roles: roleNames(estimate.unmeasured) }) : t("autopilot.estimate.minutesWhy"),
  };
}

/** A range for the eyes and for a screen reader: «1,200 – 2,100» is read «1,200 to 2,100». One number is «about …», and zero is zero. */
export function RangeText({ range, format }: { range: Range; format: (value: number) => string }) {
  const { t } = useTranslation();
  if (range.min === range.max) return <>{range.min === 0 ? format(0) : t("autopilot.estimate.about", { value: format(range.min) })}</>;
  return (
    <>
      {format(range.min)}
      <span aria-hidden="true"> – </span>
      <span className="sr-only"> {t("autopilot.estimate.to")} </span>
      {format(range.max)}
    </>
  );
}

export interface StatProps {
  name: string;
  label: string;
  /** What the engine computed, as it is: the page shows it rounded, and keeps the real figure where a test or a tool can read it. */
  real: Range | null;
  shown: Range | null;
  format: (value: number) => string;
  /** Said instead of a figure, when the engine could not compute one. */
  unknown: string;
  why?: ReactNode;
  more?: ReactNode;
}

export function Stat({ name, label, real, shown, format, unknown, why, more }: StatProps) {
  return (
    <div data-stat={name} className="min-w-0 space-y-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd
        className="text-base font-semibold tabular-nums"
        data-known={real && shown ? "true" : "false"}
        {...(real && shown ? { "data-min": real.min, "data-max": real.max, "data-shown-min": shown.min, "data-shown-max": shown.max } : {})}
      >
        {real && shown ? <RangeText range={shown} format={format} /> : unknown}
      </dd>
      {why && <p data-why className="text-xs text-muted-foreground">{why}</p>}
      {more}
    </div>
  );
}

const SEVERITY_ICON = { error: XCircle, warning: AlertTriangle, info: Info } as const;
const SEVERITY_BOX = {
  error: "border-destructive/40 bg-destructive/10",
  warning: "border-amber-500/40 bg-amber-500/10",
  info: "border-layer bg-muted/40",
} as const;
const SEVERITY_TEXT = {
  error: "text-destructive",
  warning: "text-amber-800 dark:text-amber-300",
  info: "text-muted-foreground",
} as const;

/** The first router row of a role that is missing a model: the one to open to give it one. */
export function rowOf(role: RoleId, capabilities: readonly EstimateCapability[]): EstimateCapability {
  const own = ROLES.find((entry) => entry.role === role)?.capabilities ?? [];
  return own.find((capability) => capabilities.includes(capability)) ?? own[0];
}

/** A way to put a problem right: a link with the look of a button and a target of 44 pixels, whatever its words. */
export function ActionLink({ to, children }: { to: string; children: ReactNode }) {
  return <Button asChild size="sm" variant="outline" className="h-auto min-h-11 whitespace-normal py-2 text-left"><Link to={to}>{children}</Link></Button>;
}

export interface WarningBoxProps {
  code: string;
  severity: "error" | "warning" | "info";
  /** The capability the warning is about, or the ones a problem that was said once for several is about. */
  capabilities?: readonly string[];
  children: ReactNode;
  /** The ways to put it right. */
  buttons?: ReactNode;
}

/** One warning: its gravity in a word and with an icon (the colour only helps), what it says, and the way to put it right. */
export function WarningBox({ code, severity, capabilities, children, buttons }: WarningBoxProps) {
  const { t } = useTranslation();
  const Icon = SEVERITY_ICON[severity];
  return (
    <li
      data-warning={code}
      data-severity={severity}
      {...(capabilities?.length === 1 ? { "data-capability": capabilities[0] } : {})}
      {...(capabilities && capabilities.length > 1 ? { "data-capabilities": capabilities.join(" ") } : {})}
      className={cn("flex gap-2 rounded-lg border p-3 text-sm", SEVERITY_BOX[severity])}
    >
      <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", SEVERITY_TEXT[severity])} aria-hidden="true" />
      <div className="min-w-0 space-y-2">
        <p>
          <span className={cn("font-semibold", SEVERITY_TEXT[severity])}>{t(`autopilot.estimate.severity.${severity}`)}</span>{" "}
          {children}
        </p>
        {buttons && <div className="flex flex-wrap gap-2">{buttons}</div>}
      </div>
    </li>
  );
}

export interface EstimateWarningsProps {
  groups: readonly WarningGroup[];
  /** Where the book runs: the way to give a role a model is a row of the AI Router here, and the settings of the personal server there. */
  host: "browser" | "server";
  /** The configuration the estimate was made with: with no integration at all, the way to a model is AI Integrations. */
  ai: AiRuntimeConfig | null;
  /** The language the engine's own sentences are in, so that they can be marked with it. */
  textLanguage: "it" | "en";
}

/** The warnings of an estimate in words, each with the way to put it right when there is one: a role with no model, a window that is too small. */
export function EstimateWarnings({ groups, host, ai, textLanguage }: EstimateWarningsProps) {
  const { t } = useTranslation();
  const { roleName, roleNames } = useRoleNames();
  if (groups.length === 0) return null;

  const action = (group: WarningGroup): ReactNode => {
    if (group.code === "noModel") {
      if (host === "server") return <ActionLink to="/app/settings/server">{t("autopilot.estimate.actions.server")}</ActionLink>;
      if ((ai?.aiIntegrations.length ?? 0) === 0) return <ActionLink to="/app/settings/ai-integrations">{t("autopilot.estimate.actions.integrations")}</ActionLink>;
      return uniqueRoles(group.capabilities).map((role) => (
        <ActionLink key={role} to={`/app/settings/ai-router#router-row-${rowOf(role, group.capabilities)}`}>{t("autopilot.estimate.actions.routerRow", { role: roleName(role) })}</ActionLink>
      ));
    }
    if (group.code === "smallWindow") {
      if (host === "server") return <ActionLink to="/app/settings/server">{t("autopilot.estimate.actions.server")}</ActionLink>;
      return <ActionLink to={`/app/settings/ai-router#router-row-${group.capability}`}>{t("autopilot.estimate.actions.routerRow", { role: roleName(roleOf(group.capability)) })}</ActionLink>;
    }
    return null;
  };

  const sentence = (group: WarningGroup): ReactNode => {
    switch (group.code) {
      case "noModel": return t(host === "server" ? "autopilot.estimate.warning.noModelServer" : "autopilot.estimate.warning.noModel", { roles: roleNames(group.capabilities) });
      case "noPrice":
      case "noSpeed":
      case "reasoningModel": return t(`autopilot.estimate.warning.${group.code}`, { model: isolate(group.model), roles: roleNames(group.capabilities) });
      // The engine's own words, in the language of the book.
      default: return <span lang={textLanguage}>{group.text}</span>;
    }
  };

  return (
    <ul aria-label={t("autopilot.estimate.warnings.label")} className="space-y-2">
      {groups.map((group, index) => (
        <WarningBox key={`${group.code}:${index}`} code={group.code} severity={group.severity} capabilities={"capability" in group ? [group.capability] : undefined} buttons={action(group)}>
          {sentence(group)}
        </WarningBox>
      ))}
    </ul>
  );
}
