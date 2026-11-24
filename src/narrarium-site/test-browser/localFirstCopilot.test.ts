import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { localWorkspaceScope } from "@/account/deviceIdentity";
import type { LoadedWriterContext } from "@/assistant/context";
import { runAssistantPrompt } from "@/assistant/service";
import { BUILTIN_TOOLS } from "@/assistant/tools/builtinTools";
import { evaluateToolContract, missingToolRequirementsMessage } from "@/assistant/tools/runtimeContract";
import type { AppSettings, BookEntry } from "@/types/settings";
import { blockNetwork, createLocalOnlyBook, resetLocalWorkspace } from "./helpers/localFirst";

// The Copilot's tools of the remote repository (branches, commits, pull requests) say why they cannot run without GitHub; its local tools (an audit)
// are prepared from the working copy, with no request to GitHub.

const settings = {
  ui: { language: "en" },
  copilotTools: { toolOverrides: {} },
  aiIntegrations: [{ id: "ai", name: "AI", provider: "openai", apiKey: "key", chatModels: [{ id: "audit-model", name: "model", capabilities: ["audit"] }] }],
} as unknown as AppSettings;
const tool = (id: string) => BUILTIN_TOOLS.find((entry) => entry.id === id)!;
const linked: BookEntry = { id: "linked", name: "Linked", owner: "writer", repo: "novel", tokenIndex: null, activeBranch: "main", addedAt: "2026-01-01T00:00:00.000Z" };
const context = { route: { kind: "book", bookId: "linked" }, branchReady: true, branch: "main", structure: { defaultBranch: "main", readerEvaluationFiles: [], researchFiles: [] } } as unknown as LoadedWriterContext;
const runtime = (book: BookEntry, token: string) => ({ settings, book, token, branch: "main", context, attachments: [] });

beforeEach(resetLocalWorkspace);
afterEach(() => vi.unstubAllGlobals());

describe("the tools of the remote repository", () => {
  const gitTools = BUILTIN_TOOLS.filter((entry) => entry.area === "git");

  it("cover branches, commits and pull requests", () => {
    expect(gitTools.map((entry) => entry.id).sort()).toEqual(["create-pull-request", "list-branches", "list-commits", "list-pull-requests", "show-branch-diff", "switch-branch"]);
  });

  it("need a book linked to GitHub, a credential and a connection, and say which is missing", () => {
    const local: BookEntry = { ...linked, id: "local", storageMode: "local-only", owner: "", repo: "", localRepositoryId: "repo", activeBranch: "local:repo" };
    expect(evaluateToolContract(tool("list-branches"), runtime(local, "narrarium-local-repository")).missing).toEqual(["GitHub repository"]);
    expect(evaluateToolContract(tool("list-branches"), runtime(linked, "")).missing).toEqual(["GitHub credential"]);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(evaluateToolContract(tool("list-commits"), runtime(linked, "ghp_token")).missing).toEqual(["connection"]);
    vi.restoreAllMocks();
    expect(evaluateToolContract(tool("list-pull-requests"), runtime(linked, "ghp_token"))).toEqual({ available: true, missing: [] });

    expect(missingToolRequirementsMessage(tool("list-branches"), ["GitHub repository"], "en")).toBe("This needs GitHub: connect the book to GitHub to use it.");
    expect(missingToolRequirementsMessage(tool("list-branches"), ["GitHub repository"], "it")).toBe("Serve GitHub: collega il libro a GitHub per usare questa funzione.");
    expect(missingToolRequirementsMessage(tool("list-commits"), ["connection"], "it")).toBe("Sei offline: questa funzione richiede GitHub.");
    expect(missingToolRequirementsMessage(tool("list-commits"), ["GitHub credential"], "en")).toBe("This needs GitHub: connect GitHub to use it.");
  });

  it("answer a book kept on this device without a request", async () => {
    const network = blockNetwork();
    const local = await createLocalOnlyBook();
    const localContext = { ...context, route: { kind: "book", bookId: local.book.id }, branch: local.branch, structure: local.structure } as unknown as LoadedWriterContext;
    for (const prompt of ["list branches", "show recent commits", "list pull requests"]) {
      const message = await runAssistantPrompt({ prompt, context: localContext, settings, book: local.book, branch: local.branch, token: local.token, history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: localWorkspaceScope() });
      expect(message.text, prompt).toBe("This needs GitHub: connect the book to GitHub to use it.");
    }
    expect(network.requests).toEqual([]);
  });
});

describe("an audit asked to the Copilot", () => {
  it("is prepared from the working copy of a book kept on this device", async () => {
    const network = blockNetwork();
    const local = await createLocalOnlyBook();
    const localContext = { route: { kind: "book", bookId: local.book.id }, branchReady: true, branch: local.branch, structure: local.structure, chapter: null, paragraph: null } as unknown as LoadedWriterContext;

    const message = await runAssistantPrompt({ prompt: "run audit", context: localContext, settings, book: local.book, branch: local.branch, token: local.token, history: [], compactSummary: "", compactedMessageCount: 0, attachments: [], accountScope: localWorkspaceScope() });

    expect(message.action).toMatchObject({ kind: "navigate", to: `/app/books/${local.book.id}/audit`, toolId: "run-audit", sourceRevisions: { "audit/book.md": null } });
    expect(network.requests).toEqual([]);
  });
});
