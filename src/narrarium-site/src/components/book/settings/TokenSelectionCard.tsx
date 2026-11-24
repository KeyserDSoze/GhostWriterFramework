import { KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useSettingsStore } from "@/store/settingsStore";
import type { TokenMode } from "@/bookSettings/draft";

interface Props {
  mode: TokenMode;
  onMode: (mode: TokenMode) => void;
  customToken: string;
  onCustomToken: (value: string) => void;
  customTokenLabel: string;
  onCustomTokenLabel: (value: string) => void;
  /** Whether the selection gives the book a token at all. */
  hasToken: boolean;
}

/** Which token this book uses: the default one, a saved named one, or a token of its own for this repository. */
export function TokenSelectionCard({ mode, onMode, customToken, onCustomToken, customTokenLabel, onCustomTokenLabel, hasToken }: Props) {
  const { t } = useTranslation();
  const settings = useSettingsStore((state) => state.settings);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" />{t("bookSettings.githubAccess")}</CardTitle>
        <CardDescription>{t("bookSettings.githubAccessDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label>{t("bookSettings.token")}</Label>
          <Select value={mode} onValueChange={onMode}>
            <SelectTrigger className="w-full max-w-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t("bookSettings.defaultTokenOption")}{settings.defaultGitHubToken ? ` (…${settings.defaultGitHubToken.slice(-4)})` : t("bookSettings.notSet")}</SelectItem>
              {settings.extraGitHubTokens.map((token, i) => <SelectItem key={i} value={String(i)}>{token.label} (…{token.token.slice(-4)})</SelectItem>)}
              <SelectItem value="custom">{t("bookSettings.dedicatedPat")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {mode === "custom" && (
          <div className="grid gap-2 rounded-lg border border-dashed p-3">
            <p className="text-xs text-muted-foreground">{t("bookSettings.dedicatedHint")}</p>
            <div className="grid gap-2 sm:grid-cols-[1fr_2fr]">
              <Input aria-label={t("bookSettings.labelOptional")} placeholder={t("bookSettings.labelOptional")} value={customTokenLabel} onChange={(event) => onCustomTokenLabel(event.target.value)} />
              <Input aria-label={t("bookSettings.dedicatedPat")} type="password" placeholder="github_pat_…" value={customToken} onChange={(event) => onCustomToken(event.target.value)} autoComplete="off" />
            </div>
            <p className="text-xs text-muted-foreground">{t("bookSettings.createOneAt")} <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="underline">github.com/settings/tokens</a> {t("bookSettings.withPermissions")}</p>
          </div>
        )}

        {!hasToken && mode !== "custom" && (
          <Alert variant="destructive"><AlertDescription>{t("bookSettings.noTokenWarning")}</AlertDescription></Alert>
        )}
      </CardContent>
    </Card>
  );
}
