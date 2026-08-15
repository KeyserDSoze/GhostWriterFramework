import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button } from "@/components/ui/button";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("browser test infrastructure", () => {
  it("resolves Vite aliases and renders interactive React components in the DOM", () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Run Copilot</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Run Copilot" }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("supports fake timers and network mocks", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async () => new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", request);
    let completed = false;
    setTimeout(() => { completed = true; }, 250);
    await vi.advanceTimersByTimeAsync(250);
    expect(completed).toBe(true);
    expect((await fetch("https://example.test")).ok).toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });
});
