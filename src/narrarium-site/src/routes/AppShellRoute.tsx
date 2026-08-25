import { AuthGuard } from "@/components/auth/AuthGuard";
import { Shell } from "@/components/layout/Shell";
import { installAccountScopeIsolation } from "@/auth/accountScope";

installAccountScopeIsolation();

export function AppShellRoute() {
  return <AuthGuard><Shell /></AuthGuard>;
}
