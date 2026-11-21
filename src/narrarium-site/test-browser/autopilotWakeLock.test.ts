import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenWakeLock } from "@/autopilot/wakeLock";
import { fakeSentinel, flushMicrotasks as flush, installFakeWakeLock, type FakeSentinel } from "./helpers/fakeWakeLock";

let wake: ReturnType<typeof installFakeWakeLock>;

beforeEach(() => {
  wake = installFakeWakeLock();
});

afterEach(() => {
  wake.uninstall();
  vi.restoreAllMocks();
});

describe("the screen wake lock of a local run", () => {
  it("is taken when the run starts and released when it ends", async () => {
    const lock = new ScreenWakeLock();
    lock.start();
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(1);
    expect(wake.state.request).toHaveBeenCalledWith("screen");
    expect(lock.held).toBe(true);

    await lock.stop();
    expect(wake.state.issued[0].release).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false);
  });

  it("is taken again when the tab comes back, because the browser dropped it in the background", async () => {
    const lock = new ScreenWakeLock();
    lock.start();
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(1);

    wake.state.issued[0].revoke();
    wake.setVisibility("hidden");
    await flush();
    expect(lock.held).toBe(false);
    expect(wake.state.request).toHaveBeenCalledTimes(1);

    wake.setVisibility("visible");
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(2);
    expect(lock.held).toBe(true);

    // And again, as many times as the tab goes away and returns.
    wake.state.issued[1].revoke();
    wake.setVisibility("hidden");
    wake.setVisibility("visible");
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(3);
    await lock.stop();
  });

  it("does not ask while the tab is hidden, and asks as soon as it is shown", async () => {
    wake.state.visibility = "hidden";
    const lock = new ScreenWakeLock();
    lock.start();
    await flush();
    expect(wake.state.request).not.toHaveBeenCalled();

    wake.setVisibility("visible");
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(1);
    await lock.stop();
  });

  it("does not take it again once the run is over, whatever the tab does", async () => {
    const lock = new ScreenWakeLock();
    lock.start();
    await flush();
    await lock.stop();

    wake.setVisibility("hidden");
    wake.setVisibility("visible");
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(1);
  });

  it("keeps a single request in flight when the tab is shown twice quickly", async () => {
    let resolveRequest: (value: FakeSentinel) => void = () => undefined;
    wake.onRequest(() => new Promise<FakeSentinel>((resolve) => { resolveRequest = resolve; }));
    const lock = new ScreenWakeLock();
    lock.start();
    wake.setVisibility("visible");
    wake.setVisibility("visible");
    await flush();
    expect(wake.state.request).toHaveBeenCalledTimes(1);

    const granted = fakeSentinel();
    resolveRequest(granted);
    await flush();
    expect(lock.held).toBe(true);
    await lock.stop();
    expect(granted.release).toHaveBeenCalledTimes(1);
  });

  it("lets go of a lock that was granted after the run had already ended", async () => {
    let resolveRequest: (value: FakeSentinel) => void = () => undefined;
    wake.onRequest(() => new Promise<FakeSentinel>((resolve) => { resolveRequest = resolve; }));
    const lock = new ScreenWakeLock();
    lock.start();
    await flush();
    await lock.stop();

    const late = fakeSentinel();
    resolveRequest(late);
    await flush();
    expect(late.release).toHaveBeenCalledTimes(1);
    expect(lock.held).toBe(false);
  });

  it("is refused without a fuss (low battery, power saving) and tried again the next time the tab is shown", async () => {
    let refuse = true;
    wake.onRequest(async () => {
      if (refuse) throw new DOMException("Wake Lock permission request denied", "NotAllowedError");
      const next = fakeSentinel();
      wake.state.issued.push(next);
      return next;
    });
    const lock = new ScreenWakeLock();
    expect(() => lock.start()).not.toThrow();
    await flush();
    expect(lock.held).toBe(false);

    refuse = false;
    wake.setVisibility("hidden");
    wake.setVisibility("visible");
    await flush();
    expect(lock.held).toBe(true);
    await lock.stop();
  });

  it("does nothing where the browser has no wake lock", async () => {
    wake.removeApi();
    const lock = new ScreenWakeLock();
    expect(() => lock.start()).not.toThrow();
    await flush();
    expect(lock.held).toBe(false);
    await expect(lock.stop()).resolves.toBeUndefined();
  });

  it("copes with a lock that cannot be released", async () => {
    const stubborn = fakeSentinel();
    stubborn.release.mockRejectedValue(new Error("already released"));
    wake.onRequest(async () => stubborn);
    const lock = new ScreenWakeLock();
    lock.start();
    await flush();
    await expect(lock.stop()).resolves.toBeUndefined();
  });
});
