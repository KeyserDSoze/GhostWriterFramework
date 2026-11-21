import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autopilotRuntime } from "@/autopilot/runtime";
import { flushMicrotasks as flush, installFakeWakeLock } from "./helpers/fakeWakeLock";

/** The runtime's own use of the wake lock, seen only through what the browser is asked to do. */
const runtime = autopilotRuntime as unknown as { sessions: Map<string, unknown>; onLocalRunChanged(): void };

let wake: ReturnType<typeof installFakeWakeLock>;

beforeEach(() => {
  wake = installFakeWakeLock();
});

afterEach(() => {
  runtime.sessions.clear();
  runtime.onLocalRunChanged();
  wake.uninstall();
});

describe("a local run and the screen", () => {
  it("is kept awake for as long as the run is active, even after the tab went to the background and came back", async () => {
    runtime.sessions.set("book-1", { key: "book-1:main", session: { running: true }, unsubscribe: () => undefined });
    runtime.onLocalRunChanged();
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(1);

    wake.state.issued[0].revoke();
    wake.setVisibility("hidden");
    wake.setVisibility("visible");
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(2);
  });

  it("lets the screen go to sleep again when the run ends", async () => {
    runtime.sessions.set("book-1", { key: "book-1:main", session: { running: true }, unsubscribe: () => undefined });
    runtime.onLocalRunChanged();
    await flush();
    runtime.sessions.clear();
    runtime.onLocalRunChanged();
    await flush();
    expect(wake.state.issued[0].release).toHaveBeenCalledTimes(1);

    wake.setVisibility("hidden");
    wake.setVisibility("visible");
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(1);
  });

  it("is not an error when the browser refuses the lock", async () => {
    wake.onRequest(async () => { throw new DOMException("denied", "NotAllowedError"); });
    runtime.sessions.set("book-1", { key: "book-1:main", session: { running: true }, unsubscribe: () => undefined });
    expect(() => runtime.onLocalRunChanged()).not.toThrow();
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(1);
  });
});
