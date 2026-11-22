import { useId } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { effectivePublish, type AutopilotLimitsSummary, type AutopilotPausePending, type AutopilotPublishMode, type AutopilotState, type AutopilotStateSummary } from "narrarium-engine";
import { useSettings } from "@/drive/useSettings";
import { useBookAutopilotView } from "@/autopilot/hooks";
import type { HandoverPlan, HandoverSide } from "@/autopilot/handover";
import type { BookOperation } from "@/autopilot/operations";
import { serverHasQuickControls } from "@/autopilot/quickControls";
import { useServerConnection } from "@/autopilot/serverConnection";
import { useAutopilotStore } from "@/autopilot/store";
import { isProfileProblemStop } from "@/autopilot/stopReason";
import { useAutopilotActions, type AutopilotActionName, type AutopilotCommands } from "@/autopilot/useAutopilotActions";
import { useAutopilotControl, type AutopilotControl } from "@/autopilot/useAutopilotControl";
import { useSettingsStore } from "@/store/settingsStore";
import { bookStorageMode, resolveGitHubRemoteToken, type BookEntry } from "@/types/settings";

export type QuickVariant = "page" | "dock";

/** Everything the groups of the bar need to know, worked out once from the stores, the settings and the connection to the server. */
export interface QuickModel {
  bookId: string;
  variant: QuickVariant;
  book: BookEntry;
  host: HandoverSide;
  /** What tells this bar from every other that commands the same book: the title, and the panel when it is the live panel. */
  context: string;
  /** The accessible name of a control: what it says, and which bar and which book it commands. */
  named: (label: string) => string;
  pageHref: string;
  control: AutopilotControl;
  summary: AutopilotStateSummary;
  state: AutopilotState | null;
  busy: AutopilotActionName | null;
  operation: BookOperation | null;
  /** Something is going on with the book: an action of this bar, or an operation of the page, the dock or another tab. */
  acting: boolean;
  /** A pause or a stop was sent and has not been answered yet. */
  pausing: boolean;
  /** The autopilot runs somewhere this client cannot reach: nothing that goes to the run is sent. */
  unreachable: boolean;
  awaitingPlan: boolean;
  completed: boolean;
  /** This browser would run the book without an AI model to run it with. */
  noAi: boolean;
  profileStop: boolean;
  pausePending: AutopilotPausePending | null;
  limits: AutopilotLimitsSummary | null;
  handover: HandoverPlan | null;
  github: boolean;
  token: boolean;
  publish: AutopilotPublishMode;
  serverUsable: boolean;
  serverConfigured: boolean;
  /** The server that runs this book has the quick controls (a book that this browser runs does not depend on it). */
  serverControls: boolean;
  /** The server has the quick controls, which a run limited to some steps needs when it runs there. */
  serverKeepsLimits: boolean;
  commands: AutopilotCommands;
  save: () => Promise<unknown>;
  /** Open the flow of “Where it runs” on the page of the book, with the side the author wants to pass to. */
  openWhere: (side: HandoverSide) => void;
  ids: { remote: string; stopHint: string; noAi: string; where: string; publish: string; busy: string; more: string };
}

/** The model of the bar of a book, or `null` while the autopilot of the book has no state to command. */
export function useQuickModel(bookId: string, variant: QuickVariant): QuickModel | null {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const baseId = useId();
  const settings = useSettingsStore((state) => state.settings);
  const view = useBookAutopilotView(bookId);
  const control = useAutopilotControl(bookId);
  const server = useServerConnection();
  const { save } = useSettings();
  const unreachable = control.running && !control.controllable;
  const { busy, operation, commands } = useAutopilotActions(bookId, { unreachable });
  const book = settings.books.find((entry) => entry.id === bookId);
  const summary = control.summary;
  if (!book || !summary) return null;

  const host: HandoverSide = book.autopilotHost === "server" ? "server" : "browser";
  const state = view.snapshot?.state ?? null;
  const context = variant === "dock" ? t("autopilot.quick.contextDock", { book: book.name, panel: t("autopilot.dockTitle") }) : book.name;
  const pageHref = `/app/books/${encodeURIComponent(bookId)}/autopilot`;
  // A server that has not said what it can do yet (the connection is being made) is not taken for an old one: a command it would misread is
  // checked again against the identity it proves when it is sent, and refused there.
  const controls = server.info ? serverHasQuickControls(server.info) : true;
  const ids = { remote: `${baseId}-remote`, stopHint: `${baseId}-stop`, noAi: `${baseId}-no-ai`, where: `${baseId}-where`, publish: `${baseId}-publish`, busy: `${baseId}-busy`, more: `${baseId}-more` };

  return {
    bookId,
    variant,
    book,
    host,
    context,
    named: (label) => t("autopilot.quick.named", { label, context }),
    pageHref,
    control,
    summary,
    state,
    busy,
    operation,
    acting: busy !== null,
    pausing: busy === "pause" || busy === "stop" || busy === "cancel-pause",
    unreachable,
    awaitingPlan: Boolean(state?.plan?.awaitingAuthor),
    completed: summary.status === "completed",
    noAi: host === "browser" && settings.aiIntegrations.length === 0,
    profileStop: isProfileProblemStop(summary),
    pausePending: summary.pausePending ?? null,
    limits: summary.limits ?? null,
    handover: view.handover,
    github: bookStorageMode(book) === "github",
    token: Boolean(resolveGitHubRemoteToken(book, settings)),
    // What the host says it does now; a host that predates the field leaves it to the options, as the engine does.
    publish: summary.publish ?? effectivePublish(state?.options, host === "server" ? "step" : undefined),
    serverUsable: server.status === "online",
    serverConfigured: server.status !== "disabled",
    serverControls: host === "server" ? controls : true,
    serverKeepsLimits: controls,
    commands,
    save,
    openWhere: (side) => {
      useAutopilotStore.getState().setWhereIntent({ bookId, side, at: Date.now() });
      navigate({ pathname: pageHref, hash: "autopilot-where" });
    },
    ids,
  };
}
