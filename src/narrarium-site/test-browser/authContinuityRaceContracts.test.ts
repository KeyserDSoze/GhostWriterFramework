import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("auth continuity race contracts", () => {
  it("binds every persisted token to provider and immutable subject", () => {
    const store = source("src/store/authStore.ts");
    const continuity = source("src/auth/accountContinuity.ts");
    expect(store).toContain("provider: state.provider");
    expect(store).toContain("providerAccountId: state.providerAccountId");
    expect(store).toContain("provider !== user?.provider");
    expect(continuity).toContain("if (!continuity || continuity.providerAccountId !== providerAccountId)");
    expect(continuity).toContain("if (user && (user.provider !== provider || user.providerAccountId !== providerAccountId))");
  });

  it("rechecks delayed Google callbacks and stale errors against nonce plus identity", () => {
    const auth = source("src/components/auth/AuthGuard.tsx");
    expect(auth).toContain("currentAttemptRef");
    expect(auth).toContain("if (!ownsAttempt(attempt)) return;");
    expect(auth).toContain("giveUpSilent(attempt)");
    expect(auth).toContain("retryTimerGenerationRef");
    expect(auth).toContain("observedIdentityRef.current !== identity");
  });

  it("guards background Google and Microsoft refresh callbacks after awaits", () => {
    const refresh = source("src/hooks/useTokenRefresh.ts");
    expect(refresh).toContain("refreshStateRef.current.generation");
    expect(refresh).toContain("if (!ownsRefresh()) return;");
    expect(refresh).toContain("registerCloudAccount(\"google\"");
    expect(refresh).toContain("registerCloudAccount(\"microsoft\"");
  });

  it("never loops Google popups after the access token has expired", () => {
    const guard = source("src/components/auth/AuthGuard.tsx");
    const refresh = source("src/hooks/useTokenRefresh.ts");
    expect(guard).toContain("Do not launch or retry it automatically");
    expect(guard).toContain("setStatus(\"unauthenticated\")");
    expect(refresh).toContain("if (Date.now() >= accessTokenExpiry) return;");
    expect(refresh).toContain("if (googleAttemptRef.current?.key === key) return;");
    expect(refresh).toContain("current.invalidateToken()");
    expect(refresh).not.toContain("RETRY_AFTER_MS");
  });

  it("requires the popup-selected Microsoft account on silent results", () => {
    const login = source("src/components/auth/LoginScreen.tsx");
    expect(login).toContain("silentResult.account.homeAccountId !== result.account.homeAccountId");
    expect(login).toContain("silentResult.account.localAccountId !== result.account.localAccountId");
    expect(login).toContain("graphToken = result.accessToken");
  });
});
