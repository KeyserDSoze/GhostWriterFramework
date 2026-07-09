import type { AppSettings } from "@/types/settings";
import type { CopilotToolDescriptor } from "./types";

class ToolRegistry {
  private tools = new Map<string, CopilotToolDescriptor>();

  register(tool: CopilotToolDescriptor) {
    this.tools.set(tool.id, tool);
  }

  registerMany(tools: CopilotToolDescriptor[]) {
    tools.forEach((tool) => this.register(tool));
  }

  list(): CopilotToolDescriptor[] {
    return [...this.tools.values()].sort((a, b) => a.area.localeCompare(b.area) || a.name.localeCompare(b.name));
  }

  get(id: string): CopilotToolDescriptor | undefined {
    return this.tools.get(id);
  }
}

export const copilotToolRegistry = new ToolRegistry();

export function isCopilotToolEnabled(settings: AppSettings, tool: CopilotToolDescriptor): boolean {
  const override = settings.copilotTools.toolOverrides[tool.id]?.enabled;
  if (typeof override === "boolean") return override;
  return tool.defaultEnabled;
}
