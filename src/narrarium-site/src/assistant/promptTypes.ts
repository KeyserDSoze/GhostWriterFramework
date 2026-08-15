import type { AppSettings } from "@/types/settings";

export interface PromptInputLike {
  prompt: string;
  settings: AppSettings;
  structureLanguage?: string;
  signal?: AbortSignal;
  onText?: (text: string) => void;
}
