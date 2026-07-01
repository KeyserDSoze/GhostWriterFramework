import type { ComponentType } from "react";
import { Users, MapPin, Shield, Package, Clock, EyeOff } from "lucide-react";

export type CanonSection = "characters" | "locations" | "factions" | "items" | "timelines" | "secrets";

export interface CanonSectionMeta {
  section: CanonSection;
  icon: ComponentType<{ className?: string }>;
  /** i18n key for the section label (bookPage.*). */
  labelKey: string;
}

export const CANON_SECTIONS: Record<CanonSection, CanonSectionMeta> = {
  characters: { section: "characters", icon: Users, labelKey: "bookPage.characters" },
  locations: { section: "locations", icon: MapPin, labelKey: "bookPage.locations" },
  factions: { section: "factions", icon: Shield, labelKey: "bookPage.factions" },
  items: { section: "items", icon: Package, labelKey: "bookPage.items" },
  timelines: { section: "timelines", icon: Clock, labelKey: "bookPage.timelines" },
  secrets: { section: "secrets", icon: EyeOff, labelKey: "bookPage.secrets" },
};

export const CANON_SECTION_ORDER: CanonSection[] = ["characters", "locations", "factions", "items", "timelines", "secrets"];

export function canonSectionMeta(section: string): CanonSectionMeta | undefined {
  return CANON_SECTIONS[section as CanonSection];
}
