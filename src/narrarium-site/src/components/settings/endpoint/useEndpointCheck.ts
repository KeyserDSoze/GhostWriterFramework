import { useCallback, useEffect, useRef, useState } from "react";
import type { AiEndpointProbe } from "narrarium-engine";
import type { AIIntegration } from "@/types/settings";

/** What the check of the connection of one integration has found so far. */
export type EndpointCheck =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "done"; probe: AiEndpointProbe }
  /** The check could not be made at all (the code that makes it could not be loaded, or the integration has no list to ask); `message` is the engine's English words, when it has some. */
  | { status: "failed"; message?: string };

const IDLE: EndpointCheck = { status: "idle" };

/**
 * The check of the connection of an integration: one short question to its endpoint, with the address and the key as they are now. What it found is about that address and that key, so a
 * change of either, of the provider, or the end of the view, forgets the result and cancels a check that is on its way; a second press while one is on its way asks nothing more.
 * The code that asks is loaded when the author presses the button and not with the page that shows it: the settings page and the panel of an error carry no catalog code.
 */
export function useEndpointCheck(integration: AIIntegration): { state: EndpointCheck; check: () => void; checking: boolean } {
  const [state, setState] = useState<EndpointCheck>(IDLE);
  const running = useRef<AbortController | null>(null);
  const latest = useRef(integration);
  latest.current = integration;
  const identity = `${integration.provider}\n${integration.endpoint ?? ""}\n${integration.apiKey}`;

  useEffect(() => () => {
    running.current?.abort();
    running.current = null;
    setState(IDLE);
  }, [identity]);

  const check = useCallback(() => {
    if (running.current) return;
    const controller = new AbortController();
    running.current = controller;
    setState({ status: "checking" });
    const target = latest.current;
    void (async () => {
      let tools: typeof import("@/ai/endpointTools") | undefined;
      try {
        tools = await import("@/ai/endpointTools");
        const probe = await tools.checkEndpoint(target, { signal: controller.signal });
        if (!controller.signal.aborted) setState({ status: "done", probe });
      } catch (error) {
        if (!controller.signal.aborted) setState({ status: "failed", message: tools?.failureOf(error, target).message });
      } finally {
        if (running.current === controller) running.current = null;
      }
    })();
  }, []);

  return { state, check, checking: state.status === "checking" };
}
