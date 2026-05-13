import { useNavigate, useLocation } from "react-router-dom";
import { useGoogleLogin } from "@react-oauth/google";
import { BookOpen, Loader2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuthStore, type GoogleUser } from "@/store/authStore";
import { useSettings } from "@/drive/useSettings";
import { ThemeToggle } from "@/components/layout/ThemeToggle";

export function LoginScreen() {
  const { setAuth } = useAuthStore();
  const { load } = useSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useGoogleLogin({
    scope: [
      "https://www.googleapis.com/auth/drive.appdata",
      "openid",
      "profile",
      "email",
    ].join(" "),
    onSuccess: async (tokenResponse) => {
      setLoading(true);
      setError(null);
      try {
        // Fetch user profile
        const profileRes = await fetch(
          "https://www.googleapis.com/oauth2/v3/userinfo",
          { headers: { Authorization: `Bearer ${tokenResponse.access_token}` } },
        );
        const profile = (await profileRes.json()) as {
          name: string;
          email: string;
          picture: string;
        };

        const user: GoogleUser = {
          name: profile.name,
          email: profile.email,
          picture: profile.picture,
        };

        setAuth(
          tokenResponse.access_token,
          user,
          "expires_in" in tokenResponse
            ? (tokenResponse as { expires_in: number }).expires_in
            : 3600,
        );
        await load();
        // Return to where the user was before being sent to login
        const returnTo =
          (location.state as { returnTo?: string } | null)?.returnTo ?? "/books";
        navigate(returnTo, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Login failed");
      } finally {
        setLoading(false);
      }
    },
    onError: (err) => {
      setError(err.error_description ?? "Google sign-in failed");
    },
  });

  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center bg-background p-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <div className="w-full max-w-sm space-y-8 text-center">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary">
            <BookOpen className="h-9 w-9 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-bold tracking-tight">
              Narrarium BMS
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Book Management System
            </p>
          </div>
        </div>

        {/* Sign-in card */}
        <div className="rounded-xl border bg-card p-8 shadow-sm space-y-6">
          <div className="space-y-2">
            <h2 className="text-lg font-semibold">Sign in to continue</h2>
            <p className="text-sm text-muted-foreground">
              Your settings and book list are stored privately in your Google
              Drive. No data is stored on our servers.
            </p>
          </div>

          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          )}

          <Button
            className="w-full"
            onClick={() => login()}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <svg
                className="mr-2 h-4 w-4"
                aria-hidden="true"
                viewBox="0 0 24 24"
              >
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
            )}
            Continue with Google
          </Button>
        </div>

        <p className="text-xs text-muted-foreground">
          Requires a Google account to store settings in your Drive.
        </p>
      </div>
    </div>
  );
}
