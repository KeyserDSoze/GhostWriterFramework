import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRecording, resetRecordingForTests, setRecording, subscribeRecording, useRecording } from "@/autopilot/calls/recording";

// «Keep the messages of this run»: per device and per book, on unless the author turned it off; kept in this browser's localStorage, and heard across its tabs.

const KEY = "narrarium.aiCalls.recording.v1";

beforeEach(() => {
  window.localStorage.clear();
  resetRecordingForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  resetRecordingForTests();
});

describe("the recording of a book on this device", () => {
  it("is on until the author turns it off, for that book only, and what is saved is only the books it is off for", () => {
    expect(isRecording("book-a")).toBe(true);
    setRecording("book-a", false);
    expect(isRecording("book-a")).toBe(false);
    expect(isRecording("book-b")).toBe(true);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(["book-a"]);
    setRecording("book-b", false);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(["book-a", "book-b"]);
    setRecording("book-a", true);
    expect(JSON.parse(window.localStorage.getItem(KEY)!)).toEqual(["book-b"]);
    setRecording("book-b", true);
    expect(window.localStorage.getItem(KEY), "nothing is kept when every book is on").toBeNull();
  });

  it("is read again from the storage when the page starts: a reload keeps the choice", () => {
    setRecording("book-a", false);
    resetRecordingForTests();
    expect(isRecording("book-a")).toBe(false);
  });

  it("takes a stored value that is not a list of books for no choice at all", () => {
    window.localStorage.setItem(KEY, "{\"book-a\":false}");
    expect(isRecording("book-a")).toBe(true);
    resetRecordingForTests();
    window.localStorage.setItem(KEY, "not json");
    expect(isRecording("book-a")).toBe(true);
    resetRecordingForTests();
    window.localStorage.setItem(KEY, JSON.stringify(["book-a", 7, null]));
    expect(isRecording("book-a")).toBe(false);
    expect(isRecording("7")).toBe(true);
  });

  it("holds for the page when the browser refuses to keep it (a storage that throws)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    setRecording("book-a", false);
    expect(isRecording("book-a")).toBe(false);
    setRecording("book-a", true);
    expect(isRecording("book-a")).toBe(true);
  });

  it("tells whoever listens when it changes, here and in another tab of this browser", () => {
    const heard = vi.fn();
    const stop = subscribeRecording(heard);
    setRecording("book-a", false);
    expect(heard).toHaveBeenCalledTimes(1);
    // Another tab wrote the storage: this one reads it again.
    window.localStorage.setItem(KEY, JSON.stringify(["book-z"]));
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    expect(heard).toHaveBeenCalledTimes(2);
    expect(isRecording("book-a")).toBe(true);
    expect(isRecording("book-z")).toBe(false);
    window.dispatchEvent(new StorageEvent("storage", { key: "something-else" }));
    expect(heard, "a change of another key is not this one's").toHaveBeenCalledTimes(2);
    stop();
    setRecording("book-a", false);
    expect(heard).toHaveBeenCalledTimes(2);
  });

  it("draws a component again when it changes", () => {
    const { result } = renderHook(() => useRecording("book-a"));
    expect(result.current).toBe(true);
    act(() => setRecording("book-a", false));
    expect(result.current).toBe(false);
    act(() => setRecording("book-b", false));
    expect(result.current, "another book's choice is not this one's").toBe(false);
    act(() => setRecording("book-a", true));
    expect(result.current).toBe(true);
  });
});
