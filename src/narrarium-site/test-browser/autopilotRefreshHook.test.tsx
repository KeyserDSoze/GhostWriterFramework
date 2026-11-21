import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ refresh: vi.fn(async (_bookId: string, _options?: { join?: boolean }) => null) }));

vi.mock("@/autopilot/loader", () => ({ loadAutopilotRuntime: async () => ({ refresh: mocks.refresh }) }));

import { useAutopilotRefresh } from "@/autopilot/hooks";

beforeEach(() => mocks.refresh.mockClear());

describe("the page asking the runtime to load the autopilot of a book", () => {
  it("only joins a download in flight when it opens, and asks for its own when the branch or the book changes", async () => {
    const { rerender } = renderHook(({ id, key }) => useAutopilotRefresh(id, true, key), { initialProps: { id: "book-1", key: "browser:main" } });
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.refresh).toHaveBeenLastCalledWith("book-1", { join: true });

    rerender({ id: "book-1", key: "browser:draft" });
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
    expect(mocks.refresh).toHaveBeenLastCalledWith("book-1", { join: false });

    rerender({ id: "book-2", key: "browser:draft" });
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(3));
    expect(mocks.refresh).toHaveBeenLastCalledWith("book-2", { join: false });
  });

  it("joins again when it was only waiting to be allowed to load", async () => {
    const { rerender } = renderHook(({ enabled }) => useAutopilotRefresh("book-1", enabled, "browser:main"), { initialProps: { enabled: false } });
    rerender({ enabled: true });
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));
    expect(mocks.refresh).toHaveBeenLastCalledWith("book-1", { join: true });
  });

  it("does nothing without a book", async () => {
    renderHook(() => useAutopilotRefresh(undefined));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
