import { useId } from "react";
import { useTranslation } from "react-i18next";
import { AutoTextarea } from "@/components/ui/auto-textarea";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AuditSettings } from "@/types/settings";

interface Props {
  audit: AuditSettings;
  onChange: (audit: AuditSettings) => void;
}

/** How this book is checked for consistency: whether the audit is on, how deep it goes, which parts of the canon it reads and what it reports. It is saved with the rest of the book's settings. */
export function AuditTab({ audit, onChange }: Props) {
  const { t } = useTranslation();
  const patchAudit = (patch: Partial<AuditSettings>) => onChange({ ...audit, ...patch });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("bookSettings.auditSettings")}</CardTitle>
        <CardDescription>{t("bookSettings.auditSettingsDescription")}</CardDescription>
        <CardDescription>{t("bookSettings.tabs.auditHelp")}</CardDescription>
      </CardHeader>
        <CardContent className="space-y-4">
          <AuditSwitch label={t("bookSettings.auditEnabled")} checked={audit.enabled} onChange={(enabled) => patchAudit({ enabled })} />

          <div className="grid gap-4 sm:grid-cols-3">
            <div className="grid gap-2">
              <Label htmlFor="audit-report-language">{t("bookSettings.auditReportLanguage")}</Label>
              <Select value={audit.reportLanguage} onValueChange={(reportLanguage) => patchAudit({ reportLanguage: reportLanguage as AuditSettings["reportLanguage"] })} disabled={!audit.enabled}>
                <SelectTrigger id="audit-report-language"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="book">{t("bookSettings.auditLanguageBook")}</SelectItem>
                  <SelectItem value="en">{t("bookSettings.auditLanguageEnglish")}</SelectItem>
                  <SelectItem value="it">{t("bookSettings.auditLanguageItalian")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="audit-default-depth">{t("bookSettings.auditDefaultDepth")}</Label>
              <Select value={audit.defaultDepth} onValueChange={(defaultDepth) => patchAudit({ defaultDepth: defaultDepth as AuditSettings["defaultDepth"] })} disabled={!audit.enabled}>
                <SelectTrigger id="audit-default-depth"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="quick">{t("bookSettings.auditDepthQuick")}</SelectItem>
                  <SelectItem value="standard">{t("bookSettings.auditDepthStandard")}</SelectItem>
                  <SelectItem value="deep">{t("bookSettings.auditDepthDeep")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="audit-severity-threshold">{t("bookSettings.auditSeverityThreshold")}</Label>
              <Select value={audit.severityThreshold} onValueChange={(severityThreshold) => patchAudit({ severityThreshold: severityThreshold as AuditSettings["severityThreshold"] })} disabled={!audit.enabled}>
                <SelectTrigger id="audit-severity-threshold"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="critical">{t("bookSettings.auditSeverityCritical")}</SelectItem>
                  <SelectItem value="high">{t("bookSettings.auditSeverityHigh")}</SelectItem>
                  <SelectItem value="medium">{t("bookSettings.auditSeverityMedium")}</SelectItem>
                  <SelectItem value="low">{t("bookSettings.auditSeverityLow")}</SelectItem>
                  <SelectItem value="informational">{t("bookSettings.auditSeverityInformational")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <AuditSwitch label={t("bookSettings.auditIncludeTimeline")} checked={audit.includeTimeline} onChange={(includeTimeline) => patchAudit({ includeTimeline })} disabled={!audit.enabled} />
            <AuditSwitch label={t("bookSettings.auditIncludeSecrets")} checked={audit.includeSecrets} onChange={(includeSecrets) => patchAudit({ includeSecrets })} disabled={!audit.enabled} />
            <AuditSwitch label={t("bookSettings.auditIncludeCharacters")} checked={audit.includeCharacters} onChange={(includeCharacters) => patchAudit({ includeCharacters })} disabled={!audit.enabled} />
            <AuditSwitch label={t("bookSettings.auditIncludeLocations")} checked={audit.includeLocations} onChange={(includeLocations) => patchAudit({ includeLocations })} disabled={!audit.enabled} />
            <AuditSwitch label={t("bookSettings.auditIncludeItems")} checked={audit.includeItems} onChange={(includeItems) => patchAudit({ includeItems })} disabled={!audit.enabled} />
            <AuditSwitch label={t("bookSettings.auditIncludeFactions")} checked={audit.includeFactions} onChange={(includeFactions) => patchAudit({ includeFactions })} disabled={!audit.enabled} />
            <AuditSwitch label={t("bookSettings.auditIncludeGhostwriter")} checked={audit.includeGhostwriter} onChange={(includeGhostwriter) => patchAudit({ includeGhostwriter })} disabled={!audit.enabled} />
            <AuditSwitch label={t("bookSettings.auditIncludeSummary")} checked={audit.includeSummary} onChange={(includeSummary) => patchAudit({ includeSummary })} disabled={!audit.enabled} />
            <AuditSwitch label={t("bookSettings.auditIncludePreviousContext")} checked={audit.includePreviousContext} onChange={(includePreviousContext) => patchAudit({ includePreviousContext })} disabled={!audit.enabled} />
            <AuditSwitch label={t("bookSettings.auditIncludeNextContext")} checked={audit.includeNextContext} onChange={(includeNextContext) => patchAudit({ includeNextContext })} disabled={!audit.enabled} />
            <AuditSwitch label={t("bookSettings.auditGenerateFixSuggestions")} checked={audit.generateFixSuggestions} onChange={(generateFixSuggestions) => patchAudit({ generateFixSuggestions })} disabled={!audit.enabled} />
          </div>

          <div className="grid gap-2 sm:max-w-xs">
            <Label htmlFor="audit-max-findings">{t("bookSettings.auditMaxFindings")}</Label>
            <Input id="audit-max-findings" type="number" min={1} max={500} value={audit.maxFindings} onChange={(event) => {
              const maxFindings = Number(event.target.value);
              if (Number.isFinite(maxFindings)) patchAudit({ maxFindings: Math.max(1, Math.min(500, Math.round(maxFindings))) });
            }} disabled={!audit.enabled} />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="audit-custom-prompt">{t("bookSettings.auditCustomPrompt")}</Label>
            <AutoTextarea id="audit-custom-prompt" value={audit.customPrompt} onChange={(event) => patchAudit({ customPrompt: event.target.value })} placeholder={t("bookSettings.auditCustomPromptPlaceholder")} className="min-h-24" disabled={!audit.enabled} />
          </div>
      </CardContent>
    </Card>
  );
}

function AuditSwitch({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border p-3">
      <span id={id} className="text-sm font-medium">{label}</span>
      <Switch aria-labelledby={id} checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </div>
  );
}
