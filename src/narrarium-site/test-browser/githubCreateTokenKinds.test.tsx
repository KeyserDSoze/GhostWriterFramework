import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/config/publicClients", () => ({ GITHUB_APP_CLIENT_ID: "Iv1.client-id", GITHUB_APP_SLUG: "narrarium", GOOGLE_CLIENT_ID: "g", MICROSOFT_CLIENT_ID: "m" }));

import i18n from "@/i18n";
import { BookRepositoryError, PAGES_WORKFLOW_PATH, classifyTokenKind, createCompleteBookRepository, preflightBookRepository, type BookRepositoryFile } from "@/github/bookRepository";
import { bookRepositoryErrorText } from "@/github/bookRepositoryTexts";
import { GitHubCreateFailure, GitHubCreateResult } from "@/components/book/GitHubRepositoryOutcome";
import { GitHubRepositoryPanel, defaultGitHubRepositoryChoices } from "@/components/book/GitHubRepositoryPanel";
import { createFakeGitHub } from "./helpers/fakeGitHub";

// The same creation service is reached with each kind of token. Nothing is decided by the kind (the creation is tried and its refusals classified),
// but the WORDS of a refusal name what that token needs: a scope, the two permissions of a fine-grained token, or the permissions of the GitHub app.
const CLASSIC = "ghp_classicclassicclassicclassicclassic00";
const FINE = "github_pat_finegrainedfinegrainedfinegrained";
const APP = "ghu_appusertokenappusertokenappusertoken00";

const files = (): BookRepositoryFile[] => [
  { path: "README.md", content: "# Book\n" },
  { path: "book.md", content: "---\ntype: book\n---\n" },
  { path: PAGES_WORKFLOW_PATH, content: "name: Deploy\non: push\n" },
];
const run = (fake: ReturnType<typeof createFakeGitHub>, token: string, extra: Record<string, unknown> = {}) => createCompleteBookRepository({ token, octokit: fake.octokit, name: "book", files: files(), ...extra });
const caught = async (promise: Promise<unknown>) => (await promise.then(() => undefined, (error: unknown) => error)) as BookRepositoryError;

afterEach(async () => { cleanup(); await i18n.changeLanguage("en"); });

describe("what kind of token it is", () => {
  it.each([[CLASSIC, "classic"], ["gho_oauthappoauthappoauthappoauthapp0000", "classic"], [FINE, "fine-grained"], [APP, "app"], ["something-else", "unknown"], ["", "unknown"]] as const)("%s is %s", (token, kind) => {
    expect(classifyTokenKind(token)).toBe(kind);
  });
});

describe("the creation is reached with every kind of token", () => {
  it.each([["a classic personal token", CLASSIC, "classic"], ["a fine-grained personal token", FINE, "fine-grained"], ["the user token of the GitHub app", APP, "app"]] as const)("%s makes the repository, the first commit and the workflow, and says which kind it was", async (_label, token, kind) => {
    const fake = createFakeGitHub({ scopes: kind === "classic" ? "repo, workflow" : undefined });
    const result = await run(fake, token);
    expect(result).toMatchObject({ owner: "ada", repo: "book", workflow: "done", createdRepository: true, tokenKind: kind });
    expect(fake.filesAt("ada", "book")!.has(PAGES_WORKFLOW_PATH)).toBe(true);
  });

  it("a repository the app token made is written with the same token, so it is reachable for what follows", async () => {
    const fake = createFakeGitHub();
    const result = await run(fake, APP);
    expect(result.headSha).toBeTruthy();
    expect(fake.names().filter((name) => name === "git.createRef")).toHaveLength(1);
  });
});

describe("the preflight says what it knows of each kind, and never blocks", () => {
  it("a classic token: its scopes", async () => {
    const fake = createFakeGitHub({ scopes: "repo" });
    expect(await preflightBookRepository({ token: CLASSIC, octokit: fake.octokit })).toMatchObject({ tokenKind: "classic", canCreate: "yes", canWriteWorkflows: "no", issues: ["no-workflow-scope"] });
  });
  it("a fine-grained token: unverified, tried and explained afterwards", async () => {
    const fake = createFakeGitHub();
    expect(await preflightBookRepository({ token: FINE, octokit: fake.octokit })).toMatchObject({ tokenKind: "fine-grained", canCreate: "unknown", canWriteWorkflows: "unknown", issues: ["fine-grained"] });
  });
  it("the app's user token: unverified too, and said as such, even if a header of scopes is there", async () => {
    const without = createFakeGitHub();
    expect(await preflightBookRepository({ token: APP, octokit: without.octokit })).toMatchObject({ tokenKind: "app", canCreate: "unknown", canWriteWorkflows: "unknown", scopes: [], issues: ["app-token"] });
    const withHeader = createFakeGitHub({ scopes: "" });
    expect(await preflightBookRepository({ token: APP, octokit: withHeader.octokit })).toMatchObject({ tokenKind: "app", issues: ["app-token"] });
  });
});

describe.each(["en", "it"] as const)("the refusals, in words that name what the token needs (%s)", (language) => {
  const refuse = { call: "repos.createForAuthenticatedUser", status: 403, message: "Resource not accessible by integration" };
  const text = async (error: BookRepositoryError) => { await i18n.changeLanguage(language); return bookRepositoryErrorText(i18n.t.bind(i18n), error, { owner: "ada", repo: "book" }, language); };

  it("a classic token that cannot create: the «repo» scope", async () => {
    const error = await caught(run(createFakeGitHub({ scopes: "read:user", faults: [refuse] }), CLASSIC));
    expect(error).toMatchObject({ code: "cannot-create", tokenKind: "classic" });
    expect(await text(error)).toContain(language === "it" ? "Token classico: lo scope «repo»" : "Classic token: the «repo» scope");
  });

  it("a fine-grained token that cannot create: Administration or Repository creation", async () => {
    const error = await caught(run(createFakeGitHub({ faults: [refuse] }), FINE));
    expect(error).toMatchObject({ code: "cannot-create", tokenKind: "fine-grained" });
    expect(await text(error)).toContain(language === "it" ? "Token a grana fine: Administration" : "Fine-grained token: Administration");
  });

  it("the app's token that cannot create: the permission of the APP, an owner for an organization, and the way out (create the empty repository yourself)", async () => {
    const error = await caught(run(createFakeGitHub({ faults: [refuse] }), APP));
    expect(error).toMatchObject({ code: "cannot-create", tokenKind: "app", status: 403 });
    const words = await text(error);
    expect(words).toContain(language === "it" ? "La GitHub App non può creare repository per ada" : "The GitHub app cannot create repositories for ada");
    expect(words).toContain("Repository creation");
    expect(words).toContain("Administration");
    expect(words).toContain(language === "it" ? "repository vuoto su github.com" : "empty repository on github.com");
    expect(words).not.toMatch(/Classic token|Token classico|«repo»/);
  });

  it("a single sign-on refusal keeps its own explanation, for any token kind", async () => {
    const sso = { call: "repos.createForAuthenticatedUser", status: 403, message: "Resource protected by organization SAML enforcement", headers: { "x-github-sso": "required; url=https://github.com/orgs/x/sso" } };
    const error = await caught(run(createFakeGitHub({ faults: [sso] }), APP));
    expect(error).toMatchObject({ code: "cannot-create", reason: "sso-required" });
    expect(await text(error)).toContain(language === "it" ? "single sign-on" : "single sign-on");
  });

  it("the app's token that made the repository but cannot write to it: it is not installed on it, and the words say so", async () => {
    const fake = createFakeGitHub({ faults: [{ call: "git.createTree", status: 403, message: "Resource not accessible by integration" }] });
    const error = await caught(run(fake, APP));
    expect(error).toMatchObject({ code: "first-commit-failed", tokenKind: "app", repository: { owner: "ada", repo: "book" } });
    expect(await text(error)).toContain(language === "it" ? "la GitHub App non lo raggiunge ancora" : "the GitHub app cannot reach it yet");
    const classic = await caught(run(createFakeGitHub({ scopes: "repo", faults: [{ call: "git.createTree", status: 403, message: "Resource not accessible by integration" }] }), CLASSIC));
    expect(await text(classic)).not.toContain(language === "it" ? "la GitHub App non lo raggiunge ancora" : "the GitHub app cannot reach it yet");
  });

  it("the app's token refused for the workflow commit: the repository stays, and the result names the «Workflows» permission", async () => {
    await i18n.changeLanguage(language);
    const fake = createFakeGitHub({ workflowRefusal: { status: 403, message: "refusing to allow a GitHub App to create or update workflow `.github/workflows/deploy-reader-pages.yml` without `workflows` permission" } });
    const result = await run(fake, APP);
    expect(result).toMatchObject({ workflow: "not-allowed", tokenKind: "app" });
    expect(result.pendingWorkflow.map((file) => file.path)).toEqual([PAGES_WORKFLOW_PATH]);
    render(<GitHubCreateResult result={result} onOpenBook={() => undefined} />);
    expect(screen.getByText(language === "it" ? /la GitHub App non ha il permesso «Workflows»/ : /the GitHub app has no «Workflows» permission/)).toBeInTheDocument();
    cleanup();
    const classic = await run(createFakeGitHub({ scopes: "repo", workflowRefusal: { status: 403, message: "refusing to allow an OAuth App to create or update workflow without `workflow` scope" } }), CLASSIC);
    render(<GitHubCreateResult result={classic} onOpenBook={() => undefined} />);
    expect(screen.queryByText(language === "it" ? /la GitHub App non ha il permesso/ : /the GitHub app has no/)).toBeNull();
  });

  it("the failure shows a button to the app's install page for an app token, and none for a PAT", async () => {
    await i18n.changeLanguage(language);
    const fake = createFakeGitHub({ faults: [refuse] });
    const error = await caught(run(fake, APP));
    render(<GitHubCreateFailure error={error} owner="ada" repo="book" busy={false} onRetry={() => undefined} onDelete={async () => undefined} />);
    expect(screen.getByRole("link", { name: new RegExp(language === "it" ? "Scegli i repository su GitHub" : "Choose repositories on GitHub") })).toHaveAttribute("href", "https://github.com/apps/narrarium/installations/new");
    cleanup();
    const pat = await caught(run(createFakeGitHub({ faults: [refuse] }), FINE));
    render(<GitHubCreateFailure error={pat} owner="ada" repo="book" busy={false} onRetry={() => undefined} onDelete={async () => undefined} />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("the panel tells the app token's story before the creation is tried", async () => {
    await i18n.changeLanguage(language);
    const fake = createFakeGitHub();
    const preflight = await preflightBookRepository({ token: APP, octokit: fake.octokit });
    render(<GitHubRepositoryPanel choices={defaultGitHubRepositoryChoices()} onChange={() => undefined} preflight={{ status: "ready", preflight }} hasToken />);
    // It speaks of the app, not of a token: where it works, and the three permissions it needs.
    const note = screen.getByText(language === "it" ? /Questa è la connessione GitHub \(l'app\)/ : /This is the GitHub connection \(the app\)/, { exact: false });
    expect(note).toBeInTheDocument();
    for (const permission of ["Repository creation", "Contents", "Workflows"]) expect(note).toHaveTextContent(permission);
    expect(screen.getByRole("heading", { name: language === "it" ? "Sulla connessione GitHub (l'app)" : "About the GitHub connection (the app)" })).toBeInTheDocument();
    expect(screen.queryByText(/grana fine|fine-grained/)).not.toBeInTheDocument();
  });
});
