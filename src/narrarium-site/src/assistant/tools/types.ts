export type CopilotToolArea =
  | "navigation"
  | "reader"
  | "research"
  | "canon"
  | "book"
  | "chapter"
  | "paragraph"
  | "git"
  | "export"
  | "audio"
  | "notes"
  | "settings"
  | "custom-actions"
  | "utility";

export interface CopilotToolParam {
  name: string;
  type: string;
  description: string;
  required?: boolean;
}

export type CopilotToolPrerequisite =
  | "attachments"
  | "book open"
  | "canon entity open"
  | "chapter open"
  | "chapter or paragraph open"
  | "context loaded"
  | "current page"
  | "git token"
  | "non-default branch"
  | "note open"
  | "paragraph open"
  | "reader evaluations available"
  | "research available";

export interface CopilotToolDescriptor {
  id: string;
  area: CopilotToolArea;
  name: string;
  description: string;
  params: CopilotToolParam[];
  output: string;
  prerequisites: CopilotToolPrerequisite[];
  requiresLlm: boolean;
  mutatesData: boolean;
  destructive: boolean;
  defaultEnabled: boolean;
  /** Keywords used by the first planner pass. */
  keywords: string[];
  /** Service-level handler id that executes the tool when selected. */
  handlerId?: string;
}
