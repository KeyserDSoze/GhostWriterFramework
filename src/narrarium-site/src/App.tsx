import { RouterProvider } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { MsalProvider } from "@azure/msal-react";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { Toaster } from "@/components/ui/toaster";
import { router } from "@/router";
import { msalInstance } from "@/config/msal";

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

export default function App() {
  return (
    <MsalProvider instance={msalInstance}>
      <GoogleOAuthProvider clientId={googleClientId ?? ""}>
        <ThemeProvider>
          <RouterProvider router={router} />
          <Toaster />
        </ThemeProvider>
      </GoogleOAuthProvider>
    </MsalProvider>
  );
}
