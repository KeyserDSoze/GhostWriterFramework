import type { AppSettings } from "@/types/settings";

export interface PromptInputLike {
  prompt: string;
  settings: AppSettings;
  structureLanguage?: string;
  signal?: AbortSignal;
  expectedRemoteHeadSha?: string;
  onText?: (text: string) => void;
}
