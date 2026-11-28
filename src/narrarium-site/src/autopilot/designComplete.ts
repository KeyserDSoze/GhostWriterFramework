import { serverSupportsDesignComplete, type ServerInfo } from "narrarium-engine";
import i18n from "@/i18n";

/** The release of the personal server that reviews and completes a book (`autopilot-design-complete`: the mode `complete` of a design, and the route that applies its proposals). */
export const DESIGN_COMPLETE_SERVER_VERSION = "0.1.29";

/** Whether the personal server announces «Review and complete». An older one would refuse the mode, and has no route for the proposals. */
export function serverHasDesignComplete(info: Pick<ServerInfo, "features"> | null | undefined): boolean {
  return serverSupportsDesignComplete(info);
}

/** The personal server is older than «Review and complete»: nothing was asked of it. */
export class AutopilotDesignCompleteUnsupportedError extends Error {
  constructor() {
    super(i18n.t("autopilot.designComplete.oldServer", { version: DESIGN_COMPLETE_SERVER_VERSION }));
    this.name = "AutopilotDesignCompleteUnsupportedError";
  }
}
