import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import "@/i18n/githubCreateBook";
import { BookRepositoryError, PAGES_WORKFLOW_PATH, type CreateCompleteBookRepositoryResult } from "@/github/bookRepository";
import { GitHubRepositoryPanel, defaultGitHubRepositoryChoices, ownerOf, type GitHubPreflightState, type GitHubRepositoryChoices } from "@/components/book/GitHubRepositoryPanel";
import { GitHubCreateFailure, GitHubCreateProgress, GitHubCreateResult } from "@/components/book/GitHubRepositoryOutcome";

// The parts of the creation of a repository the user sees: the choices and the checklist before, the progress while it works, the result and the manual
// steps after, and the failure that leaves an empty repository. Both languages; the structure that a keyboard and a screen reader depend on.

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options) as string;
const WORKFLOW = "name: Deploy Reader To GitHub Pages\non: push\n";

function result(overrides: Partial<CreateCompleteBookRepositoryResult> = {}): CreateCompleteBookRepositoryResult {
  return { id: 1, owner: "Ada", repo: "book-glass-harbor", defaultBranch: "main", htmlUrl: "https://github.com/Ada/book-glass-harbor", private: true, committed: { files: 150, bytes: 420_000 }, workflow: "done", pages: "skipped", warnings: [], headSha: "a".repeat(40), shas: {}, firstCommitPath: "direct", createdRepository: true, pendingWorkflow: [], ...overrides };
}

const ready = (overrides: Record<string, unknown> = {}): GitHubPreflightState => ({ status: "ready", preflight: { login: "ada", tokenKind: "classic", scopes: ["repo", "workflow"], organizations: ["acme", "zeta"], canCreate: "yes", canWriteWorkflows: "yes", issues: [], ...overrides } as never });

function Panel({ preflight = ready(), hasToken = true, initial }: { preflight?: GitHubPreflightState; hasToken?: boolean; initial?: Partial<GitHubRepositoryChoices> }) {
  const [choices, setChoices] = useState<GitHubRepositoryChoices>({ ...defaultGitHubRepositoryChoices(), ...initial });
  return (
    <>
      <GitHubRepositoryPanel choices={choices} onChange={setChoices} preflight={preflight} hasToken={hasToken} />
      <output data-testid="choices">{JSON.stringify({ owner: ownerOf(choices), visibility: choices.visibility, pages: choices.pages })}</output>
    </>
  );
}
const choices = () => JSON.parse(screen.getByTestId("choices").textContent!) as { owner?: string; visibility: string; pages: boolean };

beforeEach(async () => { await i18n.changeLanguage("en"); });
afterEach(async () => { cleanup(); vi.restoreAllMocks(); await i18n.changeLanguage("en"); });

describe("the choices before the creation", () => {
  it("lets the user pick their own account, an organization the token can see, or another one by name, in a labelled select", () => {
    render(<Panel />);
    const owner = screen.getByLabelText(t("github.createBook.panel.owner.label")) as HTMLSelectElement;
    expect([...owner.options].map((option) => option.textContent)).toEqual(["ada (your account)", "acme (organization)", "zeta (organization)", "Another organization…"]);
    expect(choices().owner).toBeUndefined();
    fireEvent.change(owner, { target: { value: "acme" } });
    expect(choices().owner).toBe("acme");
    expect(screen.queryByLabelText(t("github.createBook.panel.owner.otherLabel"))).not.toBeInTheDocument();
    fireEvent.change(owner, { target: { value: "__other__" } });
    const other = screen.getByLabelText(t("github.createBook.panel.owner.otherLabel"));
    fireEvent.change(other, { target: { value: " my-org " } });
    expect(choices().owner).toBe("my-org");
  });

  it("names the account while the token has not been read, and says how organizations are listed", () => {
    render(<Panel preflight={{ status: "loading" }} />);
    expect(screen.getByRole("option", { name: t("github.createBook.panel.owner.account") })).toBeInTheDocument();
    expect(screen.getByText(t("github.createBook.panel.owner.organizations"))).toBeInTheDocument();
  });

  it("has visibility as a group of two native radio buttons with a legend, private first and chosen, each with what it means", () => {
    render(<Panel />);
    const group = screen.getByRole("group", { name: t("github.createBook.panel.visibility.legend") });
    const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
    expect(radios.map((radio) => radio.parentElement?.textContent)).toEqual([expect.stringContaining("Private"), expect.stringContaining("Public")]);
    expect(radios[0]).toBeChecked();
    expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
    expect(radios[0]).toHaveAccessibleDescription(t("github.createBook.panel.visibility.privateHint"));
    for (const radio of radios) expect(radio.closest("label")!.className).toContain("min-h-11");
    fireEvent.click(radios[1]);
    expect(choices().visibility).toBe("public");
  });

  it("turns Pages on with a public repository and off with a private one, until the user chooses it themselves", () => {
    render(<Panel />);
    const pages = screen.getByRole("checkbox", { name: t("github.createBook.panel.pages.label") });
    expect(pages).not.toBeChecked();
    expect(pages).toHaveAccessibleDescription(t("github.createBook.panel.pages.hintPrivate"));
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    expect(pages).toBeChecked();
    expect(pages).toHaveAccessibleDescription(t("github.createBook.panel.pages.hintPublic"));
    fireEvent.click(pages);
    expect(choices().pages).toBe(false);
    fireEvent.click(screen.getByRole("radio", { name: /Private/ }));
    fireEvent.click(screen.getByRole("radio", { name: /Public/ }));
    expect(choices().pages).toBe(false);
  });

  it("lists in plain words what will be created, with Pages only when it is chosen", () => {
    render(<Panel />);
    const list = screen.getByRole("heading", { name: t("github.createBook.panel.checklist.title") }).parentElement!;
    const items = within(list).getAllByRole("listitem").map((item) => item.textContent);
    expect(items).toEqual(["book", "reader", "assistants", "workflow"].map((key) => t(`github.createBook.panel.checklist.${key}`)));
    expect(items.join(" ")).toMatch(/reader/);
    fireEvent.click(screen.getByRole("checkbox", { name: t("github.createBook.panel.pages.label") }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(5);
  });

  it("tells, before anything is made, what a classic token lacks, in a polite status", () => {
    render(<Panel preflight={ready({ scopes: ["public_repo"], canCreate: "yes", canWriteWorkflows: "no", issues: ["public-only", "no-workflow-scope"] })} />);
    const section = screen.getByRole("heading", { name: t("github.createBook.panel.token.title") }).parentElement!;
    const status = within(section).getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("A classic token with the scopes: public_repo.");
    expect(status).toHaveTextContent(t("github.createBook.panel.token.publicOnly"));
    expect(status).toHaveTextContent(t("github.createBook.panel.token.noWorkflowScope"));
  });

  it("says a fine-grained token cannot be read in advance and names the permissions it needs", () => {
    render(<Panel preflight={ready({ tokenKind: "fine-grained", scopes: [], canCreate: "unknown", canWriteWorkflows: "unknown", issues: ["fine-grained"] })} />);
    const text = within(screen.getByRole("heading", { name: t("github.createBook.panel.token.title") }).parentElement!).getByRole("status").textContent;
    expect(text).toContain("Administration");
    expect(text).toContain("Workflows read and write");
    expect(text).toContain("Pages read and write");
  });

  it("says when the token could not be read, and shows nothing about a token when there is none", () => {
    const { unmount } = render(<Panel preflight={{ status: "failed" }} />);
    expect(screen.getByText(t("github.createBook.panel.token.failed"))).toBeInTheDocument();
    unmount();
    render(<Panel hasToken={false} />);
    expect(screen.queryByRole("heading", { name: t("github.createBook.panel.token.title") })).not.toBeInTheDocument();
  });

  it("is in Italian, with the same structure", async () => {
    await i18n.changeLanguage("it");
    render(<Panel />);
    expect(screen.getByLabelText("Proprietario della repository")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Visibilità" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /Privata/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Attiva anche GitHub Pages" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cosa verrà creato" })).toBeInTheDocument();
  });

  it("disables every choice while the repository is being made", () => {
    render(<GitHubRepositoryPanel choices={defaultGitHubRepositoryChoices()} onChange={() => undefined} preflight={ready()} hasToken disabled />);
    expect(screen.getByLabelText(t("github.createBook.panel.owner.label"))).toBeDisabled();
    expect(screen.getByRole("checkbox")).toBeDisabled();
    for (const radio of screen.getAllByRole("radio")) expect(radio).toBeDisabled();
  });
});

describe("the progress", () => {
  it("is one polite line that changes, with the part it is at, and empty when nothing is happening", () => {
    const { rerender } = render(<GitHubCreateProgress progress={null} busy={false} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toBeEmptyDOMElement();
    rerender(<GitHubCreateProgress progress={{ step: "repository" }} busy />);
    expect(status).toHaveTextContent(t("github.createBook.progress.repository"));
    rerender(<GitHubCreateProgress progress={{ step: "first-commit", chunk: 2, chunks: 4 }} busy />);
    expect(status).toHaveTextContent("Sending the files of the book, part 2 of 4…");
    rerender(<GitHubCreateProgress progress={{ step: "pages" }} busy />);
    expect(status).toHaveTextContent(t("github.createBook.progress.pages"));
    rerender(<GitHubCreateProgress progress={{ step: "workflow" }} busy />);
    expect(status).toHaveTextContent(t("github.createBook.progress.workflow"));
  });
});

describe("the result", () => {
  it("takes the focus when it appears, as a labelled region", () => {
    render(<GitHubCreateResult result={result()} onOpenBook={() => undefined} />);
    const region = screen.getByRole("region", { name: t("github.createBook.result.title") });
    expect(region).toHaveFocus();
    expect(screen.getByRole("heading", { level: 2, name: t("github.createBook.result.title") })).toBeInTheDocument();
  });

  it("with everything done, says what was made and has nothing to do by hand but Pages, which was not asked for", () => {
    const onOpenBook = vi.fn();
    render(<GitHubCreateResult result={result()} onOpenBook={onOpenBook} />);
    const list = screen.getByRole("list", { name: t("github.createBook.result.listLabel") });
    expect(within(list).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "The book: 150 files (410.2 KiB) are in the first commit.",
      "The Pages workflow was added in a second commit.",
      t("github.createBook.result.pages.skipped"),
    ]);
    expect(screen.getByText(/created on GitHub as a private repository/)).toBeInTheDocument();
    expect(screen.queryByText(t("github.createBook.manual.workflow.title"))).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("github.createBook.manual.workflow.copy") })).not.toBeInTheDocument();
    expect(screen.queryByText(t("github.createBook.manual.token.title"))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.result.openBook") }));
    expect(onOpenBook).toHaveBeenCalledOnce();
    const link = screen.getByRole("link", { name: /Open the repository on GitHub/ });
    expect(link).toHaveAttribute("href", "https://github.com/Ada/book-glass-harbor");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveTextContent("(opens in a new tab)");
  });

  it("with Pages on, gives the address the reader will have", () => {
    render(<GitHubCreateResult result={result({ pages: "enabled", private: false })} onOpenBook={() => undefined} />);
    expect(screen.getByText(/https:\/\/ada\.github\.io\/book-glass-harbor\//, { selector: "li" })).toHaveTextContent("GitHub Pages is on");
    expect(screen.getByText(/public repository/)).toBeInTheDocument();
  });

  it("when the token may not write workflows, says so, offers the file to copy and the three steps, and the permission to add", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<GitHubCreateResult result={result({ workflow: "not-allowed", pendingWorkflow: [{ path: PAGES_WORKFLOW_PATH, content: WORKFLOW }], warnings: [{ code: "workflow-not-allowed", status: 403 }] })} onOpenBook={() => undefined} />);
    expect(screen.getByText(/this token may not write workflow files/)).toBeInTheDocument();
    const steps = screen.getByText(t("github.createBook.manual.workflow.step2", { path: PAGES_WORKFLOW_PATH })).closest("ol")!;
    expect(within(steps).getAllByRole("listitem")).toHaveLength(3);
    const content = screen.getByLabelText(t("github.createBook.manual.workflow.contentLabel", { path: PAGES_WORKFLOW_PATH }));
    expect(content).toHaveTextContent("Deploy Reader To GitHub Pages");
    expect(content).toHaveAttribute("tabindex", "0");
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.manual.workflow.copy") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(WORKFLOW));
    expect(await screen.findByText(t("github.createBook.manual.workflow.copied"))).toBeInTheDocument();
    const permissions = screen.getByRole("heading", { name: t("github.createBook.manual.token.title") }).parentElement!;
    expect(permissions).toHaveTextContent("classic token, the «workflow» scope");
    expect(permissions).toHaveTextContent("«Workflows: Read and write»");
  });

  it("says the copy failed and where to copy from", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    render(<GitHubCreateResult result={result({ workflow: "not-allowed", pendingWorkflow: [{ path: PAGES_WORKFLOW_PATH, content: WORKFLOW }] })} onOpenBook={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.manual.workflow.copy") }));
    expect(await screen.findByText(t("github.createBook.manual.workflow.copyFailed"))).toBeInTheDocument();
  });

  it("when Pages could not be turned on, gives the three steps, and for a private repository the reason a free plan cannot", () => {
    render(<GitHubCreateResult result={result({ pages: "manual", warnings: [{ code: "pages-plan", status: 422 }] })} onOpenBook={() => undefined} />);
    const steps = screen.getByText(t("github.createBook.manual.pages.step2")).closest("ol")!;
    expect(within(steps).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "On GitHub open the repository, then Settings → Pages.",
      "Under Build and deployment, set Source to «GitHub Actions».",
      expect.stringContaining("https://ada.github.io/book-glass-harbor/"),
    ]);
    expect(screen.getByText(t("github.createBook.manual.pages.plan"))).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: t("github.createBook.manual.token.title") }).parentElement).toHaveTextContent("«Pages: Read and write» and «Administration: Read and write»");
  });

  it("does not tell a public repository that a free plan cannot publish", () => {
    render(<GitHubCreateResult result={result({ pages: "manual", private: false })} onOpenBook={() => undefined} />);
    expect(screen.queryByText(t("github.createBook.manual.pages.plan"))).not.toBeInTheDocument();
  });

  it("says when GitHub's limit stopped the workflow, with the time", () => {
    render(<GitHubCreateResult result={result({ workflow: "skipped", pendingWorkflow: [{ path: PAGES_WORKFLOW_PATH, content: WORKFLOW }], warnings: [{ code: "workflow-rate-limit", status: 403, resetAt: "2030-01-01T10:30:00.000Z" }] })} onOpenBook={() => undefined} />);
    expect(screen.getByText(/limit on requests was reached \(try again after/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("github.createBook.manual.workflow.copy") })).toBeInTheDocument();
  });

  it("warns when the default branch is not one the workflow runs on", () => {
    render(<GitHubCreateResult result={result({ defaultBranch: "trunk", warnings: [{ code: "branch-not-main" }] })} onOpenBook={() => undefined} />);
    expect(screen.getByText(/The default branch is «trunk»/)).toBeInTheDocument();
  });

  it("is in Italian", async () => {
    await i18n.changeLanguage("it");
    render(<GitHubCreateResult result={result({ workflow: "not-allowed", pages: "manual", pendingWorkflow: [{ path: PAGES_WORKFLOW_PATH, content: WORKFLOW }] })} onOpenBook={() => undefined} />);
    expect(screen.getByRole("region", { name: "La repository è pronta" })).toBeInTheDocument();
    expect(screen.getByText(/questo token non può scrivere i file dei workflow/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copia il workflow" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apri il libro" })).toBeInTheDocument();
    expect(screen.getByText("Il permesso da aggiungere al token perché la prossima volta lo faccia il creatore")).toBeInTheDocument();
  });

  it("has a button for each thing at 44 px under a finger", () => {
    render(<GitHubCreateResult result={result({ workflow: "not-allowed", pendingWorkflow: [{ path: PAGES_WORKFLOW_PATH, content: WORKFLOW }] })} onOpenBook={() => undefined} />);
    for (const button of screen.getAllByRole("button")) expect(button.className, button.textContent ?? "").toContain("[@media(pointer:coarse)]:min-h-11");
    for (const link of screen.getAllByRole("link")) expect(link.className).toContain("[@media(pointer:coarse)]:min-h-11");
  });
});

describe("the failure", () => {
  const empty = { owner: "ada", repo: "book-glass-harbor", htmlUrl: "https://github.com/ada/book-glass-harbor", defaultBranch: "main", created: true };
  const render1 = (error: BookRepositoryError, handlers: { onRetry?: () => void; onDelete?: () => Promise<void> } = {}) => render(<GitHubCreateFailure error={error} owner="ada" repo="book-glass-harbor" busy={false} onRetry={handlers.onRetry ?? (() => undefined)} onDelete={handlers.onDelete ?? (async () => undefined)} />);

  it.each([
    ["name-taken", {}, "A repository named «book-glass-harbor» already exists in ada."],
    ["cannot-create", { status: 403 }, "This token cannot create repositories for ada. Classic token: the «repo» scope."],
    ["cannot-create", { status: 403, reason: "sso-required" as const }, "ada asks for single sign-on."],
    ["owner-unavailable", { status: 404 }, "GitHub does not know «ada»"],
    ["credential-invalid", {}, "GitHub did not accept this token."],
    ["rate-limit", {}, "GitHub's limit on requests was reached. Wait a few minutes and try again."],
    ["network", {}, "Could not reach GitHub."],
    ["too-large", {}, "The book is too large"],
    ["unknown", { status: 500 }, "GitHub answered with an error (500)."],
  ] as const)("says «%s» in words, as an alert", (code, options, text) => {
    render1(new BookRepositoryError(code, options));
    expect(screen.getByRole("alert")).toHaveTextContent(text);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("gives the time a rate limit ends", () => {
    render1(new BookRepositoryError("rate-limit", { resetAt: "2030-01-01T10:30:00.000Z" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Try again after \d{1,2}:\d{2}/);
  });

  it("is in Italian", async () => {
    await i18n.changeLanguage("it");
    render1(new BookRepositoryError("name-taken"));
    expect(screen.getByRole("alert")).toHaveTextContent("Esiste già una repository chiamata «book-glass-harbor» in ada. Scegli un altro nome.");
  });

  it("when the repository exists and is empty, says exactly that and offers to send the files again or to delete it", () => {
    const onRetry = vi.fn();
    render1(new BookRepositoryError("first-commit-failed", { reason: "service-unavailable", repository: empty }), { onRetry });
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("The repository ada/book-glass-harbor was created, but sending the files of the book failed. It is empty for now. GitHub had a problem.");
    expect(alert).toHaveTextContent("The empty repository is still there");
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.recover.retry") }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: /Open it on GitHub/ })).toHaveAttribute("href", empty.htmlUrl);
  });

  it("says the reason when a rate limit stopped the first commit", () => {
    render1(new BookRepositoryError("first-commit-failed", { reason: "rate-limit", resetAt: "2030-01-01T10:30:00.000Z", repository: empty }));
    expect(screen.getByRole("alert")).toHaveTextContent(/It is empty for now\. GitHub's limit on requests was reached\. Try again after/);
  });

  it("deletes the empty repository only after a second, explicit step, with the focus on the safe answer", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render1(new BookRepositoryError("first-commit-failed", { reason: "network", repository: empty }), { onDelete });
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.recover.delete") }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText("Delete ada/book-glass-harbor for good? It has no files.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t("github.createBook.recover.confirmNo") })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.recover.confirmNo") }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: t("github.createBook.recover.retry") })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.recover.delete") }));
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.recover.confirmYes") }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledOnce());
    expect(await screen.findByText(t("github.createBook.recover.deleted"))).toBeInTheDocument();
  });

  it("tells where to delete it by hand when the token cannot", async () => {
    render1(new BookRepositoryError("first-commit-failed", { reason: "network", repository: empty }), { onDelete: async () => { throw new BookRepositoryError("cannot-delete"); } });
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.recover.delete") }));
    fireEvent.click(screen.getByRole("button", { name: t("github.createBook.recover.confirmYes") }));
    expect(await screen.findByText(t("github.createBook.recover.deleteFailed"))).toBeInTheDocument();
  });

  it("does not offer to delete a repository this creation did not make", () => {
    render1(new BookRepositoryError("first-commit-failed", { reason: "network", repository: { ...empty, created: false } }));
    expect(screen.getByRole("button", { name: t("github.createBook.recover.retry") })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t("github.createBook.recover.delete") })).not.toBeInTheDocument();
  });
});
