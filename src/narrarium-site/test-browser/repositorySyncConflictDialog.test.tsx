import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { RepositorySyncConflictDialog } from "@/components/repository/RepositorySyncConflictDialog";

test("shows local and remote conflict content and requires one choice per file", () => {
  const onApply = vi.fn();
  render(<RepositorySyncConflictDialog
    conflicts={[{
      path: "ghostwriters/default.md",
      kind: "text",
      localContent: "local line",
      remoteContent: "remote line",
      localDeleted: false,
      remoteDeleted: false,
      localHash: "local-hash",
      remoteSha: "remote-sha",
      localBaseSha: "base-sha",
      localChanged: true,
    }]}
    busy={false}
    onCancel={vi.fn()}
    onApply={onApply}
  />);

  expect(screen.getByText("ghostwriters/default.md")).toBeInTheDocument();
  expect(screen.getByText("local line")).toBeInTheDocument();
  expect(screen.getByText("remote line")).toBeInTheDocument();
  const apply = screen.getByRole("button", { name: "repoStatus.applyConflictChoices" });
  expect(apply).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "repoStatus.keepLocal" }));
  expect(apply).toBeEnabled();
  fireEvent.click(apply);
  expect(onApply).toHaveBeenCalledWith({ "ghostwriters/default.md": "local" });
});
