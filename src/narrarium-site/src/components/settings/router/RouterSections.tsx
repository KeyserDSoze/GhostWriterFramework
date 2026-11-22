import "@/i18n/aiRouter";
import { ROUTER_SECTIONS } from "@/router/routerTableModel";
import type { AppSettings } from "@/types/settings";
import { RouterSection } from "./RouterSection";

/** The four tables of the AI Router: text, text-to-speech, transcription and images, one after the other. */
export function RouterSections({ settings, patchSettings }: { settings: AppSettings; patchSettings: (patch: Partial<AppSettings>) => void }) {
  return (
    <div className="space-y-4">
      {ROUTER_SECTIONS.map((id) => <RouterSection key={id} id={id} settings={settings} patchSettings={patchSettings} />)}
    </div>
  );
}
