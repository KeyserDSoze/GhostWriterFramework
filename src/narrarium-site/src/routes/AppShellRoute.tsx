import { AuthGuard } from "@/components/auth/AuthGuard";
import { Shell } from "@/components/layout/Shell";
import { installAccountScopeIsolation } from "@/auth/accountScope";
import { cacheAppShellPwaAssets } from "@/pwa";

installAccountScopeIsolation();
void cacheAppShellPwaAssets();

export function AppShellRoute() {
  return <AuthGuard><Shell /></AuthGuard>;
}
