import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }), toast: vi.fn() }));
vi.mock("@/drive/useSettings", () => ({ useSettings: () => ({ load: async () => undefined, save: vi.fn(async () => undefined), resolveOfflineConflict: async () => undefined, syncStatus: "idle", lastSynced: null }) }));

import i18n from "@/i18n";
import "@/i18n/annotations";
import { SettingsPage } from "@/pages/SettingsPage";
import { AnnotationTagsSettingsBody } from "@/components/settings/AnnotationTagsSettingsBody";
import { useSettingsStore } from "@/store/settingsStore";
import { DEFAULT_SETTINGS, type AppSettings } from "@/types/settings";
import { builtinTag, BUILTIN_TAGS, type AnnotationTagDefinition, type AppLanguage } from "@/annotations/model";

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const LANGUAGES: AppLanguage[] = ["en", "it"];

beforeAll(() => i18n.changeLanguage("en"));
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
  await i18n.changeLanguage("en");
});

describe("Settings › Annotation tags", () => {
  function Harness({ initial, onChange }: { initial: AppSettings; onChange: (settings: AppSettings) => void }) {
    const [settings, setSettings] = useState(initial);
    return <AnnotationTagsSettingsBody settings={settings} patchSettings={(patch) => setSettings((current) => { const next = { ...current, ...patch }; onChange(next); return next; })} />;
  }

  it.each(LANGUAGES)("show the built-in tags in the language of the app, and make, change, move and delete the tags for every book (%s)", async (language) => {
    await i18n.changeLanguage(language);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    let latest: AppSettings = DEFAULT_SETTINGS;
    render(<Harness initial={DEFAULT_SETTINGS} onChange={(settings) => { latest = settings; }} />);

    const builtin = screen.getByRole("region", { name: t("annotations.settings.builtinTitle") });
    expect(within(builtin).getAllByRole("listitem").map((item) => item.querySelector(".annotation-mark-sample")?.textContent)).toEqual(BUILTIN_TAGS.map((entry) => builtinTag(entry.id, language)!.name));
    const custom = screen.getByRole("region", { name: t("annotations.settings.customTitle") });
    expect(within(custom).getByText(t("annotations.settings.empty"))).toBeInTheDocument();

    for (const name of ["Doubt", "Slow pace"]) {
      fireEvent.click(within(custom).getByRole("button", { name: t("annotations.settings.add") }));
      fireEvent.change(within(custom).getByRole("textbox", { name: t("annotations.tagEditor.name") }), { target: { value: name } });
      fireEvent.click(within(custom).getByRole("button", { name: t("annotations.tagEditor.create") }));
    }
    // A built-in name is taken.
    fireEvent.click(within(custom).getByRole("button", { name: t("annotations.settings.add") }));
    fireEvent.change(within(custom).getByRole("textbox", { name: t("annotations.tagEditor.name") }), { target: { value: builtinTag("keep", language)!.name.toUpperCase() } });
    fireEvent.click(within(custom).getByRole("button", { name: t("annotations.tagEditor.create") }));
    expect(within(custom).getByText(t("annotations.tagEditor.nameTaken"))).toBeInTheDocument();
    fireEvent.click(within(custom).getByRole("button", { name: t("annotations.tagEditor.cancel") }));

    const names = () => (latest.annotations?.tags ?? []).filter((entry) => !entry.deletedAt).map((entry) => entry.name);
    expect(names()).toEqual(["Doubt", "Slow pace"]);
    expect(within(custom).getByRole("button", { name: t("annotations.settings.moveUp", { name: "Doubt" }) })).toBeDisabled();
    fireEvent.click(within(custom).getByRole("button", { name: t("annotations.settings.moveDown", { name: "Doubt" }) }));
    expect(names()).toEqual(["Slow pace", "Doubt"]);

    fireEvent.click(within(custom).getByRole("button", { name: t("annotations.tag.edit", { name: "Doubt" }) }));
    fireEvent.change(within(custom).getByRole("textbox", { name: t("annotations.tagEditor.name") }), { target: { value: "Doubts" } });
    fireEvent.click(within(custom).getByRole("button", { name: t("annotations.tagEditor.save") }));
    expect(names()).toEqual(["Slow pace", "Doubts"]);

    fireEvent.click(within(custom).getByRole("button", { name: t("annotations.tag.delete", { name: "Slow pace" }) }));
    expect(confirm).toHaveBeenCalledWith(t("annotations.settings.deleteConfirm", { name: "Slow pace" }));
    expect(names()).toEqual(["Doubts"]);
    // A deleted tag stays as a tombstone, so that another copy of the account data does not bring it back.
    expect(latest.annotations?.tags?.find((entry) => entry.name === "Slow pace")?.deletedAt).toBeTruthy();
    expect(within(custom).queryByText("Slow pace")).toBeNull();
  });

  it("leave what a newer app wrote as it was: entries they cannot read, fields and mark values they do not know", () => {
    const future = { id: "future-5e6f", name: "Future", description: "", mark: { underline: "zigzag", color: "teal", icon: "lightning" }, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", instructions: { model: "fast" } } as unknown as AnnotationTagDefinition;
    const initial: AppSettings = { ...DEFAULT_SETTINGS, annotations: { tags: [future, null as unknown as AnnotationTagDefinition], publicNoticeSeen: ["writer/novel"] } };
    let latest = initial;
    render(<Harness initial={initial} onChange={(settings) => { latest = settings; }} />);
    fireEvent.click(screen.getByRole("button", { name: t("annotations.tag.edit", { name: "Future" }) }));
    fireEvent.change(screen.getByRole("textbox", { name: t("annotations.tagEditor.name") }), { target: { value: "Present" } });
    fireEvent.click(screen.getByRole("button", { name: t("annotations.tagEditor.save") }));
    expect(latest.annotations?.tags).toEqual([
      expect.objectContaining({ id: "future-5e6f", name: "Present", mark: { underline: "zigzag", color: "teal", icon: "lightning" }, instructions: { model: "fast" } }),
      null,
    ]);
    expect(latest.annotations?.publicNoticeSeen).toEqual(["writer/novel"]);
  });

  it("are a section of Settings, with its card on the home of Settings", async () => {
    useSettingsStore.setState({ settings: DEFAULT_SETTINGS });
    const { unmount } = render(<MemoryRouter initialEntries={["/app/settings"]}><SettingsPage /></MemoryRouter>);
    expect(screen.getByRole("link", { name: new RegExp(t("annotations.settings.cardTitle")) })).toHaveAttribute("href", "/app/settings/annotations");
    unmount();
    render(<MemoryRouter initialEntries={["/app/settings/annotations"]}><SettingsPage /></MemoryRouter>);
    expect(await screen.findByRole("region", { name: t("annotations.settings.builtinTitle") })).toBeInTheDocument();
  });
});
