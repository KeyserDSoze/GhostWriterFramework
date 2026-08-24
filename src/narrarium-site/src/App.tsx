import { RouterProvider } from "react-router-dom";
import { ThemeProvider } from "@/components/layout/ThemeProvider";
import { Toaster } from "@/components/ui/toaster";
import { UpdatePrompt } from "@/components/layout/UpdatePrompt";
import { InstallPrompt } from "@/components/layout/InstallPrompt";
import { RouteLoadingFallback } from "@/components/layout/RouteLoadingFallback";
import { router } from "@/router";

export default function App() {
  return (
    <ThemeProvider>
      <RouterProvider router={router} fallbackElement={<RouteLoadingFallback />} />
      <UpdatePrompt />
      <InstallPrompt />
      <Toaster />
    </ThemeProvider>
  );
}
