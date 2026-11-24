import { useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { LocalTime } from "@/components/ui/local-time";
import { useToast } from "@/components/ui/use-toast";
import { useConnectionStore } from "@/account/connectionStore";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import { checkRepositoryTokenHealth } from "@/repository/repositoryService";
import { repositoryErrorDescription } from "@/repository/repositoryError";
import { readTokenHealth, type TokenHealth } from "@/repository/tokenHealth";
import { resolveGitHubCredential, resolveBookToken, type BookEntry } from "@/types/settings";
import { useSettingsStore } from "@/store/settingsStore";
import { describeTokenStatus } from "@/bookSettings/tokenStatus";

/**
 * The state of the token this book uses. For a token of the GitHub app it says what is known (who is connected, until when the current token lasts, that it
 * renews itself); for any other it says when GitHub reports that it expires, or that it does not say. The button asks GitHub now.
 */
export function TokenStatusCard({ book, branch }: { book: BookEntry; branch: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const settings = useSettingsStore((state) => state.settings);
  const connection = useConnectionStore((state) => state.configuration.github);
  const [health, setHealth] = useState<TokenHealth | null>(null);
  const [checking, setChecking] = useState(false);
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  const token = resolveBookToken(book, settings);
  const identity = localWorkspaceScope();
  const credential = resolveGitHubCredential(book, settings);

  useEffect(() => {
    let cancelled = false;
    setHealth(null);
    if (token) void readTokenHealth({ accountIdentity: identity, token, owner: book.owner, repo: book.repo, branch }).then((value) => { if (!cancelled) setHealth(value); });
    return () => { cancelled = true; };
  }, [token, identity, book.owner, book.repo, branch]);

  async function check() {
    if (!token || !identity) return;
    setChecking(true);
    try {
      setHealth(await checkRepositoryTokenHealth({ owner: book.owner, repo: book.repo, branch, accountIdentity: identity, token }));
      toast({ title: t("repoStatus.tokenHealthy") });
    } catch (error) {
      setHealth(await readTokenHealth({ accountIdentity: identity, token, owner: book.owner, repo: book.repo, branch }));
      toast({ title: t("repoStatus.actionFailed"), description: repositoryErrorDescription(error, t), variant: "destructive" });
    } finally { setChecking(false); }
  }

  const status = describeTokenStatus({ source: credential?.source ?? null, connection, health });
  const params = { ...(status.params ?? {}) } as Record<string, unknown>;
  const time = typeof params.time === "string" ? params.time : undefined;
  const date = typeof params.date === "string" ? new Date(params.date).toLocaleDateString() : undefined;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4" />{t("repoStatus.tokenHealth")}</CardTitle>
        <CardDescription role="status">
          {t(status.key, { ...params, time: undefined, date })}
          {time && <> <LocalTime value={time} className="font-medium" /></>}
        </CardDescription>
        {health && <CardDescription>{t(`repoStatus.tokenPermission.${health.permissionStatus}`)}</CardDescription>}
      </CardHeader>
      <CardContent>
        <Button type="button" variant="outline" disabled={!token || !identity || offline || checking} onClick={() => void check()}>{checking ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <KeyRound className="mr-1 h-4 w-4" />}{t("repoStatus.checkToken")}</Button>
      </CardContent>
    </Card>
  );
}
