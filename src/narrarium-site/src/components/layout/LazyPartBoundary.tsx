import { Component, type ErrorInfo, type ReactNode } from "react";
import { noteStaleChunk } from "@/lib/staleBuild";

/**
 * Keeps a part of the shell that is loaded when it is opened (the live panel of the autopilot, the Copilot, a dialog) from taking the whole app
 * down with it when it cannot be loaded or drawn: the part closes (`onError`) and the rest of the page, the autopilots that run in this tab with
 * it, goes on. A part of an older version whose files are gone after a deployment says, through the update prompt, that a new version is
 * available; the reload stays the author's choice.
 */
export class LazyPartBoundary extends Component<{ children: ReactNode; onError?: () => void }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    if (!noteStaleChunk(error)) console.error("A part of the app could not be shown:", error, info.componentStack);
    this.props.onError?.();
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
