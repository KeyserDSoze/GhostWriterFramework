import { render } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";

const toast = vi.hoisted(() => vi.fn());
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast }) }));

import { useRewriteDatabaseBlockedNotification } from "@/hooks/useRewriteDatabaseBlockedNotification";
import { LOCAL_REWRITE_DATABASE_BLOCKED_EVENT } from "@/repository/localRewriteOperationStore";

function Notifier() { useRewriteDatabaseBlockedNotification(); return null; }

beforeEach(() => vi.clearAllMocks());

test("shows an actionable localized toast when another tab blocks the rewrite database", () => {
  const view = render(<Notifier />);
  window.dispatchEvent(new Event(LOCAL_REWRITE_DATABASE_BLOCKED_EVENT));
  expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: expect.any(String), description: expect.any(String), variant: "destructive" }));
  view.unmount();
  window.dispatchEvent(new Event(LOCAL_REWRITE_DATABASE_BLOCKED_EVENT));
  expect(toast).toHaveBeenCalledOnce();
});
