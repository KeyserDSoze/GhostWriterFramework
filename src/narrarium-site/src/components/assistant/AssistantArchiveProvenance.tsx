import type { AssistantSession } from "@/assistant/store";
import { assistantArchiveHistoryLines } from "@/assistant/chatArtifacts";

export function AssistantArchiveProvenance({ session }: { session: AssistantSession }) {
  return assistantArchiveHistoryLines(session).map((line, index) => (
    <div key={`${index}:${line}`} className="mt-1 break-all font-mono text-[11px]">{line}</div>
  ));
}
