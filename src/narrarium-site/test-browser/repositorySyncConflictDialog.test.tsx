import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import i18n from "@/i18n";
import { RepositorySyncConflictDialog, type ConflictApplyControl, type ConflictApplyOutcome } from "@/components/repository/RepositorySyncConflictDialog";
import type { RepositorySyncConflict, RepositorySyncConflictResolution, SyncResult } from "@/repository/repositoryService";
import { polyfillRadix } from "./helpers/radix";

polyfillRadix();
afterEach(cleanup);

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;

const longToken = `"request_id":"${"7f3c2a91b8e44d0c".repeat(24)}"`;
const activityLocal = Array.from({ length: 400 }, (_, index) => `  "line ${index}": "the same text on both sides",`).concat([`  "error": ${longToken},`, '  "by": "this device"']).join("\n");
const activityRemote = Array.from({ length: 400 }, (_, index) => `  "line ${index}": "the same text on both sides",`).concat(['  "by": "the server"']).join("\n");

function conflict(path: string, localContent: string, remoteContent: string, extra: Partial<RepositorySyncConflict> = {}): RepositorySyncConflict {
  return { path, kind: "text", localContent, remoteContent, localDeleted: false, remoteDeleted: false, localHash: `${path}-local`, remoteSha: `${path}-remote`, localBaseSha: `${path}-base`, localChanged: true, ...extra };
}

const CONFLICTS = [
  conflict("autopilot/activity.json", activityLocal, activityRemote),
  conflict("autopilot/state.json", "{\n  \"version\": 409\n}\n", "{\n  \"version\": 412\n}\n"),
  conflict("evaluations/director/book.md", "# Director\n\nRead in this browser.\n", "", { remoteDeleted: true, remoteContent: null, remoteSha: null }),
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const RESULT: SyncResult = { pulled: 0, keptLocal: 3, committed: 3, pushed: 3, unpublished: 0 };

function renderDialog(onApply: (resolutions: Record<string, RepositorySyncConflictResolution>, control: ConflictApplyControl) => Promise<ConflictApplyOutcome>, conflicts = CONFLICTS) {
  const onClose = vi.fn();
  const onReload = vi.fn();
  const view = render(<RepositorySyncConflictDialog conflicts={conflicts} onApply={onApply} onClose={onClose} onReload={onReload} />);
  return { ...view, onClose, onReload, dialog: () => screen.getByRole("dialog") };
}

const radio = (choice: "local" | "remote", path: string) => screen.getByRole("radio", { name: t(choice === "local" ? "repositoryConflicts.choice.localFor" : "repositoryConflicts.choice.remoteFor", { path }) });
const applyButton = () => screen.getByRole("button", { name: t("repositoryConflicts.apply") });

test("lists every file with its two versions to keep, and applies only when each file has one", async () => {
  const onApply = vi.fn(async (_resolutions: Record<string, RepositorySyncConflictResolution>, _control: ConflictApplyControl): Promise<ConflictApplyOutcome> => ({ kind: "done", result: RESULT, reload: false }));
  const { dialog } = renderDialog(onApply);

  expect(within(dialog()).getByRole("heading", { name: t("repositoryConflicts.title") })).toBeInTheDocument();
  expect(within(dialog()).getByRole("heading", { name: t("repositoryConflicts.files", { count: 3 }) })).toBeInTheDocument();
  for (const { path } of CONFLICTS) expect(within(dialog()).getByText(path)).toBeInTheDocument();
  // What each side did, in words: GitHub deleted the evaluation.
  expect(within(dialog()).getByText(t("repositoryConflicts.side.line", { local: t("repositoryConflicts.side.sized", { state: t("repositoryConflicts.side.changed"), size: "34 B" }), remote: t("repositoryConflicts.side.deleted") }))).toBeInTheDocument();
  expect(applyButton()).toBeDisabled();
  expect(applyButton()).toHaveAccessibleDescription(`${t("repositoryConflicts.summary.chosen", { chosen: 0, total: 3 })} · ${t("repositoryConflicts.summary.left", { count: 3 })}`);

  fireEvent.click(radio("local", "autopilot/activity.json"));
  fireEvent.click(radio("remote", "autopilot/state.json"));
  expect(screen.getByText(t("repositoryConflicts.choice.remoteNote"))).toBeInTheDocument();
  expect(applyButton()).toBeDisabled();
  fireEvent.click(radio("local", "evaluations/director/book.md"));
  expect(applyButton()).toBeEnabled();
  fireEvent.click(applyButton());

  await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  expect(onApply.mock.calls[0][0]).toEqual({ "autopilot/activity.json": "local", "autopilot/state.json": "remote", "evaluations/director/book.md": "local" });
});

test("one choice for every file, and the window closes from Cancel or Escape while nothing runs", () => {
  const { onClose } = renderDialog(vi.fn());
  fireEvent.click(screen.getByRole("button", { name: t("repositoryConflicts.all.remote") }));
  for (const { path } of CONFLICTS) expect(radio("remote", path)).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: t("repositoryConflicts.all.local") }));
  for (const { path } of CONFLICTS) expect(radio("local", path)).toBeChecked();
  expect(applyButton()).toBeEnabled();

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: t("repositoryConflicts.cancel") }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

test("shows only the changed lines of a long file, its unchanged lines folded, and long lines wrapped inside their block", async () => {
  const { dialog } = renderDialog(vi.fn());
  const file = dialog().querySelector<HTMLElement>('[data-conflict-file="autopilot/activity.json"]')!;
  // The comparison runs off the drawing of the window and says what it found before any difference is shown.
  await within(file).findByText(t("repositoryConflicts.diff.stats", { added: 1, removed: 2 }));
  expect(file.querySelector("table")).toBeNull();

  const toggle = within(file).getByRole("button", { name: t("repositoryConflicts.diff.show") });
  expect(toggle).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(toggle).toHaveAccessibleName(t("repositoryConflicts.diff.hide"));
  const table = within(file).getByRole("table", { name: t("repositoryConflicts.diff.caption", { path: "autopilot/activity.json" }) });
  // Three lines of context around the change, the other 397 unchanged lines in one row: never the whole file.
  expect(within(table).getAllByRole("row").length).toBeLessThan(12);
  expect(within(table).getByText(t("repositoryConflicts.diff.gap", { count: 397 }), { exact: false })).toBeInTheDocument();
  expect(within(table).getAllByText(t("repositoryConflicts.diff.onlyLocal"))).toHaveLength(2);
  expect(within(table).getAllByText(t("repositoryConflicts.diff.onlyRemote"))).toHaveLength(1);
  // The layout keeps the table inside its block: fixed columns, and a long token breaks anywhere instead of widening the window.
  expect(table).toHaveClass("table-fixed", "w-full");
  const tokenCell = within(table).getByText((text) => text.includes("7f3c2a91b8e44d0c7f3c2a91b8e44d0c"));
  expect(tokenCell).toHaveClass("whitespace-pre-wrap", "[overflow-wrap:anywhere]");
  expect(table.closest("[data-conflict-diff]")).toHaveClass("overflow-auto", "min-w-0");
});

test("while the choices apply, it shows each step in words, announces it, disables the choices and stops only while nothing has changed", async () => {
  const running = deferred<ConflictApplyOutcome>();
  let control: ConflictApplyControl | undefined;
  const onApply = vi.fn((_: Record<string, RepositorySyncConflictResolution>, given: ConflictApplyControl) => { control = given; return running.promise; });
  const { dialog, onClose } = renderDialog(onApply);
  fireEvent.click(screen.getByRole("button", { name: t("repositoryConflicts.all.local") }));
  fireEvent.click(applyButton());

  // The choices give way to the steps, and the window cannot be closed under them.
  await screen.findByRole("heading", { name: t("repositoryConflicts.progress.title") });
  expect(dialog()).toHaveAttribute("aria-busy", "true");
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.getByRole("button", { name: t("repositoryConflicts.applying") })).toBeDisabled();
  fireEvent.keyDown(dialog(), { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();

  act(() => control!.onProgress({ step: "checking" }));
  act(() => control!.onProgress({ step: "downloading", done: 1, total: 2 }));
  const steps = () => [...dialog().querySelectorAll("[data-sync-step]")].map((step) => `${step.getAttribute("data-sync-step")}:${step.getAttribute("data-state")}`);
  expect(steps()).toEqual(["checking:done", "downloading:current"]);
  expect(screen.getByText(`(${t("repositoryConflicts.progress.count", { done: 1, total: 2 })})`)).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent(t("repositoryConflicts.progress.announce", { step: t("repositoryConflicts.progress.step.downloading") }));
  expect(screen.getByRole("button", { name: t("repositoryConflicts.progress.stop") })).toBeEnabled();

  act(() => control!.onProgress({ step: "merging" }));
  act(() => control!.onProgress({ step: "committing" }));
  act(() => control!.onProgress({ step: "publishing", done: 2, total: 3 }));
  expect(steps()).toEqual(["checking:done", "downloading:done", "merging:done", "committing:done", "publishing:current"]);
  const stop = screen.getByRole("button", { name: t("repositoryConflicts.progress.stop") });
  expect(stop).toBeDisabled();
  expect(stop).toHaveAccessibleDescription(t("repositoryConflicts.progress.noStop"));
  expect(control!.signal.aborted).toBe(false);

  await act(async () => running.resolve({ kind: "done", result: RESULT, reload: false }));
  const outcome = await screen.findByText(t("repositoryConflicts.result.title"));
  expect(outcome.closest("[data-conflicts-outcome]")).toHaveFocus();
  expect(screen.getByText(t("repositoryConflicts.result.kept", { count: 3 }))).toBeInTheDocument();
  expect(screen.getByText(t("repositoryConflicts.result.published", { count: 3 }))).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: t("repositoryConflicts.result.close") }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("a stop while GitHub is read aborts the sync and gives the choices back, untouched", async () => {
  let control: ConflictApplyControl | undefined;
  const onApply = vi.fn((_: Record<string, RepositorySyncConflictResolution>, given: ConflictApplyControl) => {
    control = given;
    return new Promise<ConflictApplyOutcome>((resolve) => given.signal.addEventListener("abort", () => resolve({ kind: "stopped" })));
  });
  renderDialog(onApply);
  fireEvent.click(radio("local", "autopilot/activity.json"));
  fireEvent.click(radio("remote", "autopilot/state.json"));
  fireEvent.click(radio("local", "evaluations/director/book.md"));
  fireEvent.click(applyButton());
  await screen.findByRole("heading", { name: t("repositoryConflicts.progress.title") });
  act(() => control!.onProgress({ step: "downloading", done: 0, total: 1 }));

  fireEvent.click(screen.getByRole("button", { name: t("repositoryConflicts.progress.stop") }));
  expect(control!.signal.aborted).toBe(true);
  const notice = await screen.findByText(t("repositoryConflicts.notice.stopped"));
  expect(notice.closest("[role=status]")).toHaveFocus();
  expect(radio("local", "autopilot/activity.json")).toBeChecked();
  expect(radio("remote", "autopilot/state.json")).toBeChecked();
  expect(applyButton()).toBeEnabled();
});

test("what came of it says what is still only on this device, and a version taken from GitHub reloads the page from the window", async () => {
  const onApply = vi.fn(async (): Promise<ConflictApplyOutcome> => ({ kind: "done", result: { pulled: 3, keptLocal: 1, committed: 1, pushed: 0, unpublished: 1 }, reload: true }));
  const { onReload, onClose } = renderDialog(onApply);
  fireEvent.click(radio("local", "autopilot/activity.json"));
  fireEvent.click(radio("remote", "autopilot/state.json"));
  fireEvent.click(radio("remote", "evaluations/director/book.md"));
  fireEvent.click(applyButton());

  await screen.findByText(t("repositoryConflicts.result.title"));
  expect(screen.getByText(t("repositoryConflicts.result.kept", { count: 1 }))).toBeInTheDocument();
  expect(screen.getByText(t("repositoryConflicts.result.taken", { count: 2 }))).toBeInTheDocument();
  expect(screen.getByText(t("repositoryConflicts.result.pulled", { count: 1 }))).toBeInTheDocument();
  expect(screen.getByText(t("repositoryConflicts.result.nothingPublished"))).toBeInTheDocument();
  expect(screen.getByText(t("repositoryConflicts.result.unpublished", { count: 1 }))).toBeInTheDocument();
  expect(screen.getByText(t("repositoryConflicts.result.reload"))).toBeInTheDocument();
  // Closing the window any way reloads, so no page keeps the version that was replaced.
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onReload).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: t("repositoryConflicts.result.reloadNow") }));
  expect(onReload).toHaveBeenCalledTimes(2);
  expect(onClose).not.toHaveBeenCalled();
});

test("a sync that failed says why in an alert and can be tried again with the same choices", async () => {
  const onApply = vi.fn()
    .mockResolvedValueOnce({ kind: "failed", message: "GitHub could not be reached." } satisfies ConflictApplyOutcome)
    .mockResolvedValueOnce({ kind: "done", result: RESULT, reload: false } satisfies ConflictApplyOutcome);
  renderDialog(onApply);
  fireEvent.click(screen.getByRole("button", { name: t("repositoryConflicts.all.local") }));
  fireEvent.click(applyButton());

  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent(t("repositoryConflicts.failed.title"));
  expect(alert).toHaveTextContent("GitHub could not be reached.");
  expect(alert).toHaveFocus();
  fireEvent.click(screen.getByRole("button", { name: t("repositoryConflicts.failed.retry") }));
  await screen.findByText(t("repositoryConflicts.result.title"));
  expect(onApply).toHaveBeenCalledTimes(2);
  expect(onApply.mock.calls[1][0]).toEqual(onApply.mock.calls[0][0]);
});

test("a list replaced while choosing starts again with no choice, and says why", async () => {
  const onApply = vi.fn(async (): Promise<ConflictApplyOutcome> => ({ kind: "replaced", reason: "stale" }));
  const view = renderDialog(onApply);
  fireEvent.click(screen.getByRole("button", { name: t("repositoryConflicts.all.local") }));
  fireEvent.click(applyButton());
  await screen.findByText(t("repositoryConflicts.notice.stale"));
  const replaced = [conflict("autopilot/state.json", "{\n  \"version\": 410\n}\n", "{\n  \"version\": 413\n}\n")];
  view.rerender(<RepositorySyncConflictDialog conflicts={replaced} onApply={onApply} onClose={view.onClose} onReload={view.onReload} />);
  await waitFor(() => expect(radio("local", "autopilot/state.json")).not.toBeChecked());
  expect(screen.queryByText("autopilot/activity.json")).toBeNull();
  expect(screen.getByText(t("repositoryConflicts.notice.stale"))).toBeInTheDocument();
  expect(applyButton()).toBeDisabled();
});

test("the texts of the resolver exist in English and Italian", async () => {
  await i18n.changeLanguage("it");
  try {
    expect(i18n.t("repositoryConflicts.apply")).toBe("Applica scelte e sincronizza");
    expect(i18n.t("repositoryConflicts.progress.step.publishing")).toBe("Pubblicazione su GitHub");
  } finally {
    await i18n.changeLanguage("en");
  }
});
