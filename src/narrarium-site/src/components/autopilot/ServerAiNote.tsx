import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Send, Server } from "lucide-react";
import { pickAiRuntimeConfig, redactAiRuntimeConfig, type ServerAiStatus } from "narrarium-engine";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/autopilot/format";
import { useServerConnection } from "@/autopilot/serverConnection";
import { verifiedServer } from "@/autopilot/serverIdentity";
import { useServerAiStatus } from "@/autopilot/useRunEstimate";
import { useSettingsStore } from "@/store/settingsStore";

/** The text of a value with its keys in order, so that two routes with the same targets are the same text whatever order they were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  return JSON.stringify(value);
}

/**
 * What a run on the personal server asks its models with. The server does not read the settings of this browser: it keeps the AI configuration that was sent to it (when the book moved there, or from the
 * settings of the server), so a change of the AI Router reaches it only when the configuration is sent again. This says so, says what the server holds and whether its routing is the one of the router here, and
 * sends the current configuration on request: the same thing «Send the AI configuration» does in the settings of the server, from the place where the author is looking at the failure.
 */
export function ServerAiNote() {
  const { t } = useTranslation();
  const read = useServerAiStatus(true);
  const server = useServerConnection();
  const settings = useSettingsStore((state) => state.settings);
  const [sent, setSent] = useState<ServerAiStatus | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [reason, setReason] = useState("");
  const status = sent ?? (read.status === "ready" ? read.value : null);
  const here = useMemo(() => canonical(redactAiRuntimeConfig(pickAiRuntimeConfig(settings)).taskRouting), [settings]);
  const comparable = Boolean(status?.configured && status.taskRouting);
  const same = comparable && canonical(status?.taskRouting) === here;

  async function send() {
    setState("sending");
    try {
      const connection = server.status === "online" ? server.connection : null;
      if (!connection) throw new Error(t("autopilot.serverAi.unavailable"));
      const { client } = await verifiedServer({ connection });
      setSent(await client.putAiConfig(pickAiRuntimeConfig(useSettingsStore.getState().settings)));
      setState("sent");
    } catch (error) {
      setReason(error instanceof Error ? error.message : String(error));
      setState("failed");
    }
  }

  return (
    <div data-server-ai-note role="note" className="space-y-2 rounded-md border border-dashed p-3 text-sm">
      <p className="flex items-center gap-2 font-medium"><Server className="h-4 w-4 shrink-0" aria-hidden="true" />{t("autopilot.serverAi.title")}</p>
      <p className="text-xs">{t("autopilot.serverAi.note")}</p>
      <p data-server-ai-state className="text-xs text-muted-foreground">
        {read.status === "unavailable" && !status ? t("autopilot.serverAi.unavailable") : status ? (status.configured ? t("autopilot.serverAi.known", { count: status.integrations.length, time: formatDateTime(status.updatedAt ?? undefined) }) : t("autopilot.serverAi.none")) : ""}
        {comparable ? ` ${t(same ? "autopilot.serverAi.same" : "autopilot.serverAi.differs")}` : ""}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={comparable && !same ? "default" : "outline"} disabled={state === "sending" || server.status !== "online"} onClick={() => void send()}>
          {state === "sending" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Send className="h-4 w-4" aria-hidden="true" />}
          {state === "sending" ? t("autopilot.serverAi.sending") : t("autopilot.serverAi.send")}
        </Button>
        <p role="status" className="min-w-0 text-xs">{state === "sent" ? t("autopilot.serverAi.sent") : state === "failed" ? t("autopilot.serverAi.failed", { reason }) : ""}</p>
      </div>
    </div>
  );
}
