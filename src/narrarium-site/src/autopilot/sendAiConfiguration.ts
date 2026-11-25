import { useState } from "react";
import { useTranslation } from "react-i18next";
import { pickAiRuntimeConfig, type ServerAiStatus } from "narrarium-engine";
import { useServerConnection } from "@/autopilot/serverConnection";
import { verifiedServer } from "@/autopilot/serverIdentity";
import { useSettingsStore } from "@/store/settingsStore";

export type SendState = "idle" | "sending" | "sent" | "failed";

/**
 * Sends the AI configuration of this browser, as it is now, to the personal server (`PUT /api/v1/ai`): the server prices and routes its runs with the one it
 * was last sent, never with the settings of a browser. What the note of a server run (`ServerAiNote`) and the note of a change of the currency of the costs
 * (`ServerCurrencyNote`) do on request. Only to a server that proved the identity this device paired with.
 */
export function useSendAiConfiguration() {
  const { t } = useTranslation();
  const server = useServerConnection();
  const [sent, setSent] = useState<ServerAiStatus | null>(null);
  const [state, setState] = useState<SendState>("idle");
  const [reason, setReason] = useState("");

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

  return { send, sent, state, reason, online: server.status === "online" };
}
