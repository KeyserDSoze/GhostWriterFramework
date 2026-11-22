import { Link, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { AlertTriangle, CircleHelp, Loader2, Plane, RotateCcw, SlidersHorizontal, XCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { BookStructureErrorAlert } from "@/components/book/BookStructureErrorAlert";
import { DangerZone } from "@/components/autopilot/config/DangerZone";
import { ProfilesUsed } from "@/components/autopilot/config/ProfilesUsed";
import { RulesEditor } from "@/components/autopilot/config/RulesEditor";
import { SetupCard } from "@/components/autopilot/config/SetupCard";
import { useAutopilotRefresh, useBookAutopilotView } from "@/autopilot/hooks";
import { autopilotLiveHref } from "@/autopilot/pageRoute";
import { QUICK_CONTROLS_SERVER_VERSION, serverHasQuickControls } from "@/autopilot/quickControls";
import { serverEditsRules } from "@/autopilot/rules";
import { useServerConnection } from "@/autopilot/serverConnection";
import { useAutopilotActions } from "@/autopilot/useAutopilotActions";
import { useAutopilotControl } from "@/autopilot/useAutopilotControl";
import { useBookStructure } from "@/hooks/useBookStructure";
import { useScrollToHash } from "@/hooks/useScrollToHash";
import { useWorkingBranch } from "@/github/useWorkingBranch";
import { useSettingsStore } from "@/store/settingsStore";

/**
 * The configuration of a book's autopilot: the brief and the settings (the book, the review, publishing), the permanent rules to change and
 * to remove, the profiles it follows with their state, and the reset. The button at the end starts the autopilot and opens the live page,
 * which shows what is happening.
 */
export function AutopilotSettingsPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const { t } = useTranslation();
  const navigate = useNavigate();
  const settings = useSettingsStore((store) => store.settings);
  const { branch, ready } = useWorkingBranch(bookId);
  const { book, structure, error, reload } = useBookStructure(bookId);
  const view = useBookAutopilotView(bookId);
  const server = useServerConnection();
  const { busy, run } = useAutopilotActions(bookId);
  const host = book?.autopilotHost === "server" ? "server" : "browser";
  const canRefresh = Boolean(book && (host === "server" || (structure && ready)));
  useAutopilotRefresh(bookId, canRefresh, `${host}:${branch}`);
  const { summary, running } = useAutopilotControl(bookId);

  const snapshot = view.snapshot;
  const loaded = Boolean(snapshot || view.error);
  const state = snapshot?.state ?? null;
  const noAi = host === "browser" && settings.aiIntegrations.length === 0;
  const existingChapters = structure?.chapters.filter((chapter) => chapter.paragraphs.length > 0).length ?? 0;
  // A link to a part of the page (the number of chapters, the rules) is followed once the page is drawn.
  useScrollToHash(loaded, state ? "state" : "fresh");

  if (error && !structure && host === "browser") return <BookStructureErrorAlert error={error} reload={reload} />;
  if (!book || !bookId) return <Alert variant="destructive"><AlertDescription>{t("bookPage.notFound")}</AlertDescription></Alert>;

  const liveHref = autopilotLiveHref(bookId);
  const reset = () => { if (window.confirm(t("autopilot.actions.resetConfirm"))) void run("reset", (runtime, id) => runtime.reset(id)); };
  // A personal server older than the editing of the rules answers 404 to it: its rules are only shown, with the way to update it.
  const rulesReadOnly = host === "server" && Boolean(server.info) && !serverEditsRules(server.info);
  // One older than the quick controls cannot change any setting during a run.
  const liveUnsupported = running && host === "server" && Boolean(server.info) && !serverHasQuickControls(server.info);
  const asking = Boolean(summary?.question);

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 font-serif text-3xl font-semibold tracking-tight"><SlidersHorizontal className="h-6 w-6 text-primary" aria-hidden="true" />{t("autopilot.config.title")}{view.loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{t("autopilot.config.description")}</p>
        </div>
        <Button asChild variant="outline"><Link to={liveHref}><Plane className="h-4 w-4" aria-hidden="true" />{t("nav.autopilotLive")}</Link></Button>
      </div>

      <div className="space-y-3 empty:hidden">
        {running && (
          <Alert role="note">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{liveUnsupported ? t("autopilot.errors.controlsUnsupported", { version: QUICK_CONTROLS_SERVER_VERSION }) : t("autopilot.config.runningNote")}</span>
              <Button asChild size="sm" variant="outline"><Link to={liveHref}>{t("autopilot.config.followLive")}</Link></Button>
            </AlertDescription>
          </Alert>
        )}
        {asking && !running && (
          <Alert role="note">
            <CircleHelp className="h-4 w-4" aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("autopilot.question.title")}</span>
              <Button asChild size="sm" variant="outline"><Link to={{ pathname: liveHref, hash: "autopilot-question" }}>{t("autopilot.quick.run.answer")}</Link></Button>
            </AlertDescription>
          </Alert>
        )}
        {noAi && !state && (
          <Alert role="note">
            <AlertTriangle className="h-4 w-4" aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("autopilot.errors.aiMissing")}</span>
              <Button asChild size="sm" variant="outline"><Link to="/app/settings/ai-integrations">{t("settingsSection.aiIntegrationsTitle")}</Link></Button>
            </AlertDescription>
          </Alert>
        )}
        {view.error && <Alert variant="destructive"><AlertDescription>{view.error}</AlertDescription></Alert>}
        {snapshot?.stateError && (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
              <span>{t("autopilot.errors.stateCorrupt")}</span>
              <Button size="sm" variant="outline" disabled={busy !== null || running} onClick={reset}>
                <RotateCcw className="h-4 w-4" />{t("autopilot.actions.reset")}
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </div>

      {!loaded ? (
        <div className="flex items-center gap-2 rounded-2xl border border-layer bg-card p-5 text-sm text-muted-foreground shadow-sm"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{t("autopilot.current.loading")}</div>
      ) : !snapshot || snapshot.stateError ? null : (
        <SetupCard
          key={bookId}
          book={book}
          state={state}
          existingChapters={existingChapters}
          running={running}
          busy={busy !== null}
          disabled={state ? false : noAi || !canRefresh}
          asking={asking}
          liveUnsupported={liveUnsupported}
          run={run}
          onStarted={() => navigate(liveHref)}
        >
          {state && <RulesEditor bookId={bookId} rules={state.constraints} readOnly={rulesReadOnly} busy={busy !== null} run={run} liveHref={liveHref} />}
          <ProfilesUsed book={book} branch={branch} structure={structure} summary={summary} />
          {state && !running && <DangerZone onReset={reset} disabled={busy !== null} />}
        </SetupCard>
      )}
    </div>
  );
}
