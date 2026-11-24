import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const resolve = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/account/accountSync", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/account/accountSync")>()), resolveAccountReconciliation: resolve.run }));

import i18n from "@/i18n";
import { ReconciliationDialog } from "@/components/account/ReconciliationDialog";
import { useAccountSyncStore, type ReplicaCandidate } from "@/account/accountSync";
import { ACCOUNT_SYNC_SCHEMA_VERSION, type AccountSyncBackendKind } from "@/account/types";
import { initialAccountManifest } from "@/account/vectorClock";
import { DEFAULT_SETTINGS } from "@/types/settings";
import { emptyCostsFile } from "@/costs/model";

const NAMES = { local: "Local device", github: "GitHub", "google-drive": "Google Drive", onedrive: "OneDrive" } as const;

function candidate(id: "local" | AccountSyncBackendKind, modifiedAtUtc: string, vectorClock: Record<string, number>): ReplicaCandidate {
  const snapshot = {
    dirty: false,
    manifest: { ...initialAccountManifest(`device-${id}`), snapshotId: id, modifiedAtUtc, vectorClock },
    data: { schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION, settings: DEFAULT_SETTINGS, costs: emptyCostsFile(), clipboard: [], chats: [] },
  };
  return { id, label: NAMES[id], comparison: id === "local" ? "same" : "diverged", snapshot };
}

function ask(candidates: ReplicaCandidate[]) {
  useAccountSyncStore.setState({ reconciliation: { local: candidates[0].snapshot as never, remotes: [], candidates } });
}

const TEXTS = {
  en: { noOverwrite: /No copy will be overwritten until you choose/, legend: "Which copy do you want to keep?", newest: "Newest copy", useNewest: "Use the newest copy", use: (name: string) => `Use the copy of ${name}`, local: "This device", cancel: "Cancel", unknown: "date unknown" },
  it: { noOverwrite: /Nessuna copia verrà sovrascritta finché non scegli/, legend: "Quale copia vuoi tenere?", newest: "Copia più recente", useNewest: "Usa la copia più recente", use: (name: string) => `Usa la copia di ${name}`, local: "Questo dispositivo", cancel: "Annulla", unknown: "data sconosciuta" },
} as const;

beforeEach(() => { resolve.run.mockReset().mockResolvedValue(undefined); });
afterEach(async () => { cleanup(); useAccountSyncStore.setState({ reconciliation: null }); await i18n.changeLanguage("en"); });

describe.each(["en", "it"] as const)("the dialog of different account copies in %s", (language) => {
  const text = TEXTS[language];
  const three = () => [candidate("local", "2026-11-20T10:00:00.000Z", { a: 2 }), candidate("github", "2026-11-22T10:00:00.000Z", { b: 3 }), candidate("google-drive", "2026-11-21T10:00:00.000Z", { c: 1 })];
  async function open(candidates = three()) {
    await i18n.changeLanguage(language);
    ask(candidates);
    render(<ReconciliationDialog />);
    return screen.findByRole("dialog");
  }

  it("lists every copy with its date and time, the newest first, labelled in words and already selected", async () => {
    const dialog = await open();
    expect(within(dialog).getByText(text.noOverwrite)).toBeInTheDocument();
    const group = within(dialog).getByRole("group", { name: text.legend });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.closest("label")!.querySelector("strong")!.textContent)).toEqual(["GitHub", "Google Drive", text.local]);
    expect(radios.map((radio) => (radio as HTMLInputElement).checked)).toEqual([true, false, false]);
    expect(within(dialog).getAllByText(text.newest)).toHaveLength(1);
    expect(radios[0].closest("label")).toHaveTextContent(text.newest);
    expect([...dialog.querySelectorAll("time")].map((time) => time.getAttribute("datetime"))).toEqual(["2026-11-22T10:00:00.000Z", "2026-11-21T10:00:00.000Z", "2026-11-20T10:00:00.000Z"]);
    expect(dialog.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it("gives every choice an accessible name made of words (not colour alone)", async () => {
    const dialog = await open();
    expect(within(dialog).getByRole("radio", { name: new RegExp(`GitHub ${text.newest}`) })).toBeChecked();
    expect(within(dialog).getByRole("radio", { name: /Google Drive/ })).not.toBeChecked();
    expect(within(dialog).getByRole("radio", { name: new RegExp(text.local) })).not.toBeChecked();
  });

  it("applies the newest copy with the primary button, and nothing before that", async () => {
    const dialog = await open();
    expect(resolve.run).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: text.useNewest }));
    await waitFor(() => expect(resolve.run).toHaveBeenCalledWith("github"));
    expect(resolve.run).toHaveBeenCalledTimes(1);
  });

  it("keeps the other copies as alternatives: choosing one renames the button and applies that copy", async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("radio", { name: new RegExp(text.local) }));
    expect(within(dialog).queryByRole("button", { name: text.useNewest })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: text.use(text.local) }));
    await waitFor(() => expect(resolve.run).toHaveBeenCalledWith("local"));
  });

  it("proposes this device when its copy is the newest", async () => {
    const dialog = await open([candidate("local", "2026-11-23T10:00:00.000Z", { a: 2 }), candidate("github", "2026-11-22T10:00:00.000Z", { b: 3 })]);
    expect(within(dialog).getByRole("radio", { name: new RegExp(`${text.local} ${text.newest}`) })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("button", { name: text.useNewest }));
    await waitFor(() => expect(resolve.run).toHaveBeenCalledWith("local"));
  });

  it("says when a copy has no readable date, and does not propose it", async () => {
    const dialog = await open([candidate("github", "no idea", { b: 3 }), candidate("local", "2026-11-23T10:00:00.000Z", { a: 2 })]);
    expect(within(dialog).getByRole("radio", { name: new RegExp(`${text.local} ${text.newest}`) })).toBeChecked();
    expect(within(dialog).getByText(text.unknown, { exact: false })).toBeInTheDocument();
  });

  it("can be cancelled without touching any copy", async () => {
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: text.cancel }));
    await waitFor(() => expect(useAccountSyncStore.getState().reconciliation).toBeNull());
    expect(resolve.run).not.toHaveBeenCalled();
  });

  it("shows why a copy could not be applied and stays open", async () => {
    resolve.run.mockRejectedValue(new Error("disk full"));
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: text.useNewest }));
    expect(await within(dialog).findByText(/disk full/)).toBeInTheDocument();
    expect(useAccountSyncStore.getState().reconciliation).not.toBeNull();
    expect(within(dialog).getByRole("button", { name: text.useNewest })).toBeEnabled();
  });
});
