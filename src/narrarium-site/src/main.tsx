import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./i18n";
import App from "./App";
import { registerServiceWorker } from "./pwa";
import { installAccountScopeIsolation } from "./auth/accountScope";

installAccountScopeIsolation();
if (__NARRARIUM_E2E_BUILD__) void import("./e2eBridge").then(({ installE2eBridge }) => installE2eBridge());

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
