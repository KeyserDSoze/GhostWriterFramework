import { Outlet } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { MsalProvider } from "@azure/msal-react";
import { microsoftMsalInstance } from "@/config/msal";
import { GOOGLE_CLIENT_ID } from "@/config/publicClients";

export function AuthProvidersRoute() {
  return (
    <MsalProvider instance={microsoftMsalInstance()}>
      <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
        <Outlet />
      </GoogleOAuthProvider>
    </MsalProvider>
  );
}
