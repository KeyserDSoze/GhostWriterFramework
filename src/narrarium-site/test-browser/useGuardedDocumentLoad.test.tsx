import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { decideLoadedDocument, useGuardedDocumentLoad } from "@/hooks/useGuardedDocumentLoad";

describe("deciding what a document read again does to an open form", () => {
  it.each([
    ["the first read fills the form", { loadedBefore: false, otherDocument: false, edited: true, baseVersion: null, version: "v1" }, "apply"],
    ["another document replaces the form: leaving was already confirmed", { loadedBefore: true, otherDocument: true, edited: true, baseVersion: "v1", version: "v2" }, "apply"],
    ["a clean form follows the newest version", { loadedBefore: true, otherDocument: false, edited: false, baseVersion: "v1", version: "v2" }, "apply"],
    ["edits stay when the document is the same version", { loadedBefore: true, otherDocument: false, edited: true, baseVersion: "v1", version: "v1" }, "keep"],
    ["edits stay, and the author is told, when the document changed underneath", { loadedBefore: true, otherDocument: false, edited: true, baseVersion: "v1", version: "v2" }, "notify"],
    ["edits stay when the document was created meanwhile", { loadedBefore: true, otherDocument: false, edited: true, baseVersion: null, version: "v2" }, "notify"],
    ["edits stay when the document disappeared", { loadedBefore: true, otherDocument: false, edited: true, baseVersion: "v1", version: null }, "notify"],
  ] as const)("%s", (_name, input, expected) => {
    expect(decideLoadedDocument(input)).toBe(expected);
  });
});

interface Read { value: string; version: string | null }

function setup(initial: { document?: string | null; source?: string; edited?: boolean } = {}) {
  const reads: Array<{ resolve: (read: Read) => void; reject: (error: unknown) => void }> = [];
  const applied: string[] = [];
  const loading: boolean[] = [];
  const errors: unknown[] = [];
  const props = { document: "book-1" as string | null, source: "main", edited: false, ...initial };
  const hook = renderHook((current: typeof props) => useGuardedDocumentLoad<string>({
    ...current,
    // A new function on every render, like an inline callback in a page.
    load: () => new Promise<Read>((resolve, reject) => { reads.push({ resolve, reject }); }),
    apply: (value) => { applied.push(value); },
    onLoading: (value) => { loading.push(value); },
    onError: (error) => { errors.push(error); },
  }), { initialProps: props });
  const finish = async (index: number, read: Read) => { await act(async () => { reads[index].resolve(read); }); };
  return { ...hook, props, reads, applied, loading, errors, finish, update: (patch: Partial<typeof props>) => hook.rerender({ ...props, ...patch }) };
}

describe("useGuardedDocumentLoad", () => {
  it("fills the form with the first read and remembers its version", async () => {
    const view = setup();
    expect(view.reads).toHaveLength(1);
    await view.finish(0, { value: "first", version: "v1" });
    expect(view.applied).toEqual(["first"]);
    expect(view.result.current.baseVersion()).toBe("v1");
    expect(view.result.current.changedElsewhere).toBe(false);
    expect(view.loading).toEqual([true, false]);
  });

  it("does not read again when the page re-renders with new callbacks, as it does whenever the settings are replaced", async () => {
    const view = setup();
    await view.finish(0, { value: "first", version: "v1" });
    for (let index = 0; index < 5; index += 1) view.update({});
    await act(async () => undefined);
    expect(view.reads).toHaveLength(1);
    expect(view.applied).toEqual(["first"]);
  });

  it("waits until there is something to read", async () => {
    const view = setup({ document: null });
    expect(view.reads).toHaveLength(0);
    view.update({ document: "book-1" });
    expect(view.reads).toHaveLength(1);
  });

  it("reads again when something it depends on changes, and replaces a clean form silently", async () => {
    const view = setup();
    await view.finish(0, { value: "first", version: "v1" });
    view.update({ source: "dev-branch" });
    expect(view.reads).toHaveLength(2);
    await view.finish(1, { value: "second", version: "v2" });
    expect(view.applied).toEqual(["first", "second"]);
    expect(view.result.current.baseVersion()).toBe("v2");
    expect(view.result.current.changedElsewhere).toBe(false);
  });

  it("never replaces unsaved edits, and stays quiet while the document is unchanged", async () => {
    const view = setup();
    await view.finish(0, { value: "first", version: "v1" });
    view.update({ edited: true });
    view.update({ edited: true, source: "dev-branch" });
    await view.finish(1, { value: "first again", version: "v1" });
    expect(view.applied).toEqual(["first"]);
    expect(view.result.current.changedElsewhere).toBe(false);
  });

  it("keeps unsaved edits and tells the author when the document changed underneath", async () => {
    const view = setup();
    await view.finish(0, { value: "first", version: "v1" });
    view.update({ edited: true, source: "dev-branch" });
    await view.finish(1, { value: "someone else's version", version: "v2" });
    expect(view.applied).toEqual(["first"]);
    expect(view.result.current.changedElsewhere).toBe(true);
    expect(view.result.current.baseVersion()).toBe("v1");
  });

  it("does not apply a read that finishes after the author started editing", async () => {
    const view = setup();
    await view.finish(0, { value: "first", version: "v1" });
    view.update({ source: "dev-branch" });
    view.update({ source: "dev-branch", edited: true });
    await view.finish(1, { value: "second", version: "v2" });
    expect(view.applied).toEqual(["first"]);
    expect(view.result.current.changedElsewhere).toBe(true);
  });

  it("applies the newest version when the author asks to reload, even over edits, and clears the notice", async () => {
    const view = setup();
    await view.finish(0, { value: "first", version: "v1" });
    view.update({ edited: true, source: "dev-branch" });
    await view.finish(1, { value: "someone else's version", version: "v2" });
    expect(view.result.current.changedElsewhere).toBe(true);

    act(() => view.result.current.reload());
    expect(view.reads).toHaveLength(3);
    await view.finish(2, { value: "someone else's version", version: "v2" });
    expect(view.applied).toEqual(["first", "someone else's version"]);
    expect(view.result.current.changedElsewhere).toBe(false);
    expect(view.result.current.baseVersion()).toBe("v2");
  });

  it("replaces the form when another document is opened, because leaving the previous one was already confirmed", async () => {
    const view = setup();
    await view.finish(0, { value: "book one", version: "v1" });
    view.update({ edited: true, document: "book-2" });
    await view.finish(1, { value: "book two", version: "w1" });
    expect(view.applied).toEqual(["book one", "book two"]);
    expect(view.result.current.baseVersion()).toBe("w1");
  });

  it("ignores a read that was superseded by a newer one", async () => {
    const view = setup();
    view.update({ source: "dev-branch" });
    expect(view.reads).toHaveLength(2);
    await view.finish(1, { value: "newer", version: "v2" });
    await view.finish(0, { value: "older, arriving late", version: "v1" });
    expect(view.applied).toEqual(["newer"]);
    expect(view.result.current.baseVersion()).toBe("v2");
  });

  it("takes the saved version as the new base, so saving is not mistaken for a change made elsewhere", async () => {
    const view = setup();
    await view.finish(0, { value: "first", version: "v1" });
    view.update({ edited: true });
    act(() => view.result.current.adopt("v2"));
    expect(view.result.current.baseVersion()).toBe("v2");
    view.update({ edited: true, source: "dev-branch" });
    await view.finish(1, { value: "my saved edit", version: "v2" });
    expect(view.result.current.changedElsewhere).toBe(false);
    expect(view.applied).toEqual(["first"]);
  });

  it("can be told that a save was refused because the document changed", async () => {
    const view = setup();
    await view.finish(0, { value: "first", version: "v1" });
    act(() => view.result.current.flagChanged());
    expect(view.result.current.changedElsewhere).toBe(true);
    act(() => view.result.current.adopt("v3"));
    expect(view.result.current.changedElsewhere).toBe(false);
  });

  it("reports a failed read without applying anything, and never leaves the form busy", async () => {
    const view = setup();
    await act(async () => { view.reads[0].reject(new Error("boom")); });
    expect(view.errors).toHaveLength(1);
    expect(view.applied).toEqual([]);
    expect(view.loading).toEqual([true, false]);
  });

  it("does not leave the form busy when a read is abandoned", async () => {
    const view = setup();
    view.update({ document: null });
    expect(view.loading[view.loading.length - 1]).toBe(false);
    await view.finish(0, { value: "late", version: "v1" });
    expect(view.applied).toEqual([]);
  });

  it("starts without a base version", () => {
    const view = setup({ document: null });
    expect(view.result.current.baseVersion()).toBeUndefined();
  });

  it("reads nothing more once the page is gone", async () => {
    const view = setup();
    view.unmount();
    await view.finish(0, { value: "late", version: "v1" });
    expect(view.applied).toEqual([]);
  });
});

describe("a page that keeps the same callbacks between renders", () => {
  it("is not affected by their identity either", async () => {
    const load = vi.fn(async () => ({ value: "x", version: "v1" }));
    const apply = vi.fn();
    const { rerender } = renderHook((props: { n: number }) => useGuardedDocumentLoad<string>({ document: "d", source: "s", edited: false, load, apply, onError: () => undefined, ...props } as never), { initialProps: { n: 0 } });
    await act(async () => undefined);
    rerender({ n: 1 });
    await act(async () => undefined);
    expect(load).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
