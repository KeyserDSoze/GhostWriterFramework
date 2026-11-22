import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReserveSpace } from "@/hooks/useReserveSpace";
import { stubWidth } from "./helpers/autopilotBand";

function Part({ name, active = true }: { name: "--top-reserve" | "--bottom-reserve" | "--dock-reserve"; active?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useReserveSpace(ref, name, active);
  return <div ref={ref} />;
}

const root = () => document.documentElement.style;

function measured(height: number) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height, width: 390, top: 0, left: 0, right: 390, bottom: height, x: 0, y: 0, toJSON: () => ({}) });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of ["--top-reserve", "--bottom-reserve", "--dock-reserve"]) root().removeProperty(name);
});

describe("the room a part of the page takes at the top or at the bottom of the screen", () => {
  it("is told to the whole page, in pixels, under the name the layout reads", () => {
    stubWidth(390);
    measured(72);
    render(<Part name="--bottom-reserve" />);
    expect(root().getPropertyValue("--bottom-reserve")).toBe("72px");
  });

  it("is forgotten when the part leaves the screen, so that the room it kept is given back", () => {
    stubWidth(390);
    measured(72);
    const view = render(<Part name="--top-reserve" />);
    expect(root().getPropertyValue("--top-reserve")).toBe("72px");
    view.unmount();
    expect(root().getPropertyValue("--top-reserve")).toBe("");
  });

  it("keeps the three rooms apart: the live panel is not lifted by its own height", () => {
    stubWidth(390);
    measured(40);
    render(<><Part name="--top-reserve" /><Part name="--dock-reserve" /></>);
    expect(root().getPropertyValue("--top-reserve")).toBe("40px");
    expect(root().getPropertyValue("--dock-reserve")).toBe("40px");
    expect(root().getPropertyValue("--bottom-reserve")).toBe("");
  });

  it("reserves nothing while it is switched off, and follows it when it is switched on", () => {
    stubWidth(390);
    measured(50);
    const view = render(<Part name="--bottom-reserve" active={false} />);
    expect(root().getPropertyValue("--bottom-reserve")).toBe("");
    view.rerender(<Part name="--bottom-reserve" active />);
    expect(root().getPropertyValue("--bottom-reserve")).toBe("50px");
  });

  it("does nothing, and breaks nothing, where the browser cannot tell sizes (no ResizeObserver)", () => {
    vi.stubGlobal("ResizeObserver", undefined);
    measured(33);
    render(<Part name="--bottom-reserve" />);
    expect(root().getPropertyValue("--bottom-reserve")).toBe("33px");
  });
});
