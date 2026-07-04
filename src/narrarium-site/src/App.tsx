import { RouterProvider } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { MsalProvider } from "@azure/msal-react";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { Toaster } from "@/components/ui/toaster";
import { UpdatePrompt } from "@/components/layout/UpdatePrompt";
import { InstallPrompt } from "@/components/layout/InstallPrompt";
import { router } from "@/router";
import { msalInstance } from "@/config/msal";
import { GOOGLE_CLIENT_ID } from "@/config/publicClients";

export default function App() {
  return (
    <MsalProvider instance={msalInstance}>
      <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
        <ThemeProvider>
          <RouterProvider router={router} />
          <UpdatePrompt />
          <InstallPrompt />
          <Toaster />
        </ThemeProvider>
      </GoogleOAuthProvider>
    </MsalProvider>
  );
}
