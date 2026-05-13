import { RouterProvider } from "react-router-dom";
import { GoogleOAuthProvider } from "@react-oauth/google";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { Toaster } from "@/components/ui/toaster";
import { router } from "@/router";

const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string;

export default function App() {
  return (
    <GoogleOAuthProvider clientId={googleClientId ?? ""}>
      <ThemeProvider>
        <RouterProvider router={router} />
        <Toaster />
      </ThemeProvider>
    </GoogleOAuthProvider>
  );
}
