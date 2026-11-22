import { afterEach, describe, expect, it, vi } from "vitest";
import { authBrokerBase, resolveAuthBrokerBase } from "@/config/authBroker";
import { GITHUB_MODELS_BASE } from "@/config/githubModels";

afterEach(() => vi.unstubAllEnvs());

describe("where the OAuth token broker lives", () => {
  it("is the origin of the Worker that proxies GitHub Models", () => {
    expect(resolveAuthBrokerBase(undefined, "https://models-github-proxy.acme.workers.dev")).toBe("https://models-github-proxy.acme.workers.dev");
    expect(resolveAuthBrokerBase(undefined, " https://models-github-proxy.acme.workers.dev/ ")).toBe("https://models-github-proxy.acme.workers.dev");
    expect(resolveAuthBrokerBase(undefined, "https://proxy.example.org/inference/")).toBe("https://proxy.example.org");
  });

  it("does not exist when the site talks to GitHub Models directly, so no request is ever sent to models.github.ai", () => {
    for (const models of [undefined, "", "   ", "https://models.github.ai", "https://models.github.ai/", "https://models.github.ai/inference"]) {
      expect(resolveAuthBrokerBase(undefined, models), String(models)).toBeNull();
    }
  });

  it("can be pointed somewhere else with VITE_AUTH_BROKER_BASE, which wins over the proxy", () => {
    expect(resolveAuthBrokerBase("https://broker.example.org/", "https://models-github-proxy.acme.workers.dev")).toBe("https://broker.example.org");
    expect(resolveAuthBrokerBase("https://broker.example.org/api/", undefined)).toBe("https://broker.example.org/api");
    expect(resolveAuthBrokerBase("https://broker.example.org", "https://models.github.ai")).toBe("https://broker.example.org");
  });

  it("falls back to the proxy when the override is blank", () => {
    expect(resolveAuthBrokerBase("   ", "https://proxy.example.org")).toBe("https://proxy.example.org");
  });

  it("fails closed on a malformed or insecure override instead of silently using another host", () => {
    for (const bad of ["not a url", "ftp://broker.example.org", "javascript:alert(1)", "http://broker.example.org", "https://user:secret@broker.example.org", "//broker.example.org"]) {
      expect(resolveAuthBrokerBase(bad, "https://proxy.example.org"), bad).toBeNull();
    }
  });

  it("accepts plain http only for the machine's own loopback addresses, for local development", () => {
    expect(resolveAuthBrokerBase("http://127.0.0.1:8787", undefined)).toBe("http://127.0.0.1:8787");
    expect(resolveAuthBrokerBase("http://localhost:8787/", undefined)).toBe("http://localhost:8787");
    expect(resolveAuthBrokerBase(undefined, "http://localhost:8787")).toBe("http://localhost:8787");
    expect(resolveAuthBrokerBase(undefined, "http://proxy.example.org")).toBeNull();
  });

  it("is read from the build variables at call time", () => {
    expect(GITHUB_MODELS_BASE).toBe("https://models.github.ai");
    expect(authBrokerBase()).toBeNull();
    vi.stubEnv("VITE_AUTH_BROKER_BASE", "http://127.0.0.1:8787");
    expect(authBrokerBase()).toBe("http://127.0.0.1:8787");
    vi.stubEnv("VITE_AUTH_BROKER_BASE", "");
    vi.stubEnv("VITE_GITHUB_MODELS_BASE", "https://proxy.example.org");
    expect(authBrokerBase()).toBe("https://proxy.example.org");
  });
});
