import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RefreshCoordinator } from "@/autopilot/refreshCoordinator";

const BOOK = "book-1";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-21T10:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

/** A download that ends when the test says so. */
function slowServer() {
  const waiting: Array<(version: number) => void> = [];
  let inFlight = 0;
  let mostInFlight = 0;
  const load = vi.fn((_bookId: string) => new Promise<number>((resolve) => {
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    waiting.push((version) => {
      inFlight -= 1;
      resolve(version);
    });
  }));
  return { load, finish: (version: number) => waiting.shift()!(version), pending: () => waiting.length, mostInFlight: () => mostInFlight };
}

/** A server whose state changes with every event, and that answers at once. */
function liveServer() {
  const started: number[] = [];
  let version = 0;
  let downloaded = -1;
  let inFlight = 0;
  let mostInFlight = 0;
  const load = vi.fn(async (_bookId: string) => {
    started.push(Date.now());
    inFlight += 1;
    mostInFlight = Math.max(mostInFlight, inFlight);
    const seen = version;
    await Promise.resolve();
    downloaded = seen;
    inFlight -= 1;
    return seen;
  });
  return { load, started, event: () => { version += 1; return version; }, downloaded: () => downloaded, mostInFlight: () => mostInFlight };
}

describe("downloads of one book", () => {
  it("happen one at a time, and once more after them for everyone who asked in the meantime", async () => {
    const server = slowServer();
    const refreshes = new RefreshCoordinator(server.load);

    const first = refreshes.refresh(BOOK);
    expect(server.load).toHaveBeenCalledTimes(1);
    const others = [refreshes.refresh(BOOK), refreshes.refresh(BOOK), refreshes.refresh(BOOK)];
    expect(server.load).toHaveBeenCalledTimes(1);

    server.finish(1);
    await expect(first).resolves.toBe(1);
    expect(server.load).toHaveBeenCalledTimes(2);
    server.finish(2);
    await expect(Promise.all(others)).resolves.toEqual([2, 2, 2]);
    expect(server.load).toHaveBeenCalledTimes(2);
    expect(server.mostInFlight()).toBe(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.load).toHaveBeenCalledTimes(2);
  });

  it("are shared by whoever asks to join the one in flight, with no download of their own", async () => {
    const server = slowServer();
    const refreshes = new RefreshCoordinator(server.load);
    const first = refreshes.refresh(BOOK, { join: true });
    const second = refreshes.refresh(BOOK, { join: true });
    expect(server.load).toHaveBeenCalledTimes(1);
    server.finish(7);
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
    expect(server.load).toHaveBeenCalledTimes(1);
  });

  it("start when someone joins and nothing is in flight", async () => {
    const server = slowServer();
    const refreshes = new RefreshCoordinator(server.load);
    const joined = refreshes.refresh(BOOK, { join: true });
    expect(server.load).toHaveBeenCalledTimes(1);
    server.finish(3);
    await expect(joined).resolves.toBe(3);
  });

  it("do not wait for each other when the books are different", async () => {
    const server = slowServer();
    const refreshes = new RefreshCoordinator(server.load);
    void refreshes.refresh("book-1");
    void refreshes.refresh("book-2");
    expect(server.load).toHaveBeenCalledTimes(2);
    expect(server.mostInFlight()).toBe(2);
  });

  it("go on after one failed, which only fails the ones that waited for it", async () => {
    const load = vi.fn<(bookId: string) => Promise<number>>().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(5);
    const refreshes = new RefreshCoordinator(load);
    await expect(refreshes.refresh(BOOK)).rejects.toThrow("offline");
    await expect(refreshes.refresh(BOOK)).resolves.toBe(5);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("downloads asked for by events", () => {
  it("wait for the delay, and one is enough for a burst of events", async () => {
    const server = liveServer();
    const refreshes = new RefreshCoordinator(server.load);
    refreshes.schedule(BOOK, { delay: 400, minInterval: 0 });
    await vi.advanceTimersByTimeAsync(100);
    refreshes.schedule(BOOK, { delay: 400, minInterval: 0 });
    refreshes.schedule(BOOK, { delay: 400, minInterval: 0 });
    expect(server.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(299);
    expect(server.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(server.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.load).toHaveBeenCalledTimes(1);
  });

  it("keep the minimum interval between two downloads however many events come, and the last event is not missed", async () => {
    const server = liveServer();
    const refreshes = new RefreshCoordinator(server.load);
    let lastEvent = 0;
    for (let index = 0; index < 300; index += 1) {
      lastEvent = server.event();
      refreshes.schedule(BOOK, { delay: 400, minInterval: 4000 });
      await vi.advanceTimersByTimeAsync(200);
    }
    // Sixty seconds of events: a download every four seconds at most.
    expect(server.load.mock.calls.length).toBeLessThanOrEqual(15);
    expect(server.load.mock.calls.length).toBeGreaterThanOrEqual(12);
    for (let index = 1; index < server.started.length; index += 1) expect(server.started[index] - server.started[index - 1]).toBeGreaterThanOrEqual(4000);
    expect(server.mostInFlight()).toBe(1);

    await vi.advanceTimersByTimeAsync(4100);
    expect(server.downloaded()).toBe(lastEvent);
    const calls = server.load.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.load.mock.calls.length).toBe(calls);
  });

  it("count the interval from the end of the previous download, so a slow server is not asked all the time", async () => {
    const server = slowServer();
    const refreshes = new RefreshCoordinator(server.load);
    refreshes.schedule(BOOK, { delay: 0, minInterval: 4000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(server.load).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6000);
    refreshes.schedule(BOOK, { delay: 0, minInterval: 4000 });
    server.finish(1);
    await vi.advanceTimersByTimeAsync(3999);
    expect(server.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(server.load).toHaveBeenCalledTimes(2);
    expect(server.mostInFlight()).toBe(1);
  });

  it("are not held back for longer than the interval by a clock that was set back", async () => {
    const server = liveServer();
    const refreshes = new RefreshCoordinator(server.load);
    await refreshes.refresh(BOOK);
    vi.setSystemTime(Date.now() - 600_000);
    refreshes.schedule(BOOK, { delay: 0, minInterval: 4000 });
    await vi.advanceTimersByTimeAsync(3999);
    expect(server.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(server.load).toHaveBeenCalledTimes(2);
  });

  it("are brought forward by an event that cannot wait, such as the end of the run", async () => {
    const server = liveServer();
    const refreshes = new RefreshCoordinator(server.load);
    await refreshes.refresh(BOOK);
    await vi.advanceTimersByTimeAsync(1000);
    refreshes.schedule(BOOK, { delay: 400, minInterval: 4000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(server.load).toHaveBeenCalledTimes(1);

    refreshes.schedule(BOOK, { delay: 500, minInterval: 0 });
    await vi.advanceTimersByTimeAsync(499);
    expect(server.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(server.load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.load).toHaveBeenCalledTimes(2);
  });

  it("are done by a download someone asks for at once, which makes the delayed one useless", async () => {
    const server = liveServer();
    const refreshes = new RefreshCoordinator(server.load);
    refreshes.schedule(BOOK, { delay: 400, minInterval: 0 });
    await refreshes.refresh(BOOK);
    expect(server.load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(server.load).toHaveBeenCalledTimes(1);
  });

  it("wait for the download in flight and then run once more, without waiting for the interval when it is zero", async () => {
    const server = slowServer();
    const refreshes = new RefreshCoordinator(server.load);
    const first = refreshes.refresh(BOOK);
    refreshes.schedule(BOOK, { delay: 400, minInterval: 0 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(server.load).toHaveBeenCalledTimes(1);
    server.finish(1);
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(server.load).toHaveBeenCalledTimes(2);
    expect(server.mostInFlight()).toBe(1);
  });
});
