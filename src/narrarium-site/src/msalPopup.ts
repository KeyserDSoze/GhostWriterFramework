import { broadcastResponseToMainFrame } from "@azure/msal-browser/redirect-bridge";

void broadcastResponseToMainFrame().catch((error: unknown) => {
  document.body.textContent = error instanceof Error ? error.message : "Microsoft sign-in could not be completed.";
});
