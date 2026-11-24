/**
 * GitHub Pages of a book repository, on and off, through any Octokit-style `request(route, parameters)` (`octokit.request` as it is): no
 * import of Octokit, Node or the DOM, so that the Narrarium site and a script use the same steps and the tests use a fake.
 *
 * Turning Pages off keeps, by default, the workflow file, the variable READER_PASSWORD_SECRETS and the password secrets: only the site is
 * taken down, and the workflow is paused (GitHub's «disable workflow») so that pushes do not run a build that would fail without a site.
 * The second, explicit choice (`removePasswords`) also deletes the variable and every reader password secret.
 *
 * Permissions (fine-grained token or GitHub App): Pages read/write and Administration read/write to turn Pages on and off; Actions
 * read/write to pause, resume and run the workflow; Variables read/write for READER_PASSWORD_SECRETS; Secrets read/write for the passwords.
 */
export type GitHubRequest = (route: string, parameters?: Record<string, unknown>) => Promise<{
    status: number;
    data?: unknown;
}>;
export interface RepositoryRef {
    owner: string;
    repo: string;
}
export interface PagesSite {
    /** `workflow` (built by Actions, what the reader needs) or `legacy` (built from a branch). */
    buildType: string | null;
    url: string | null;
    htmlUrl: string | null;
    status: string | null;
    public: boolean | null;
    cname: string | null;
}
export declare class PagesRequestError extends Error {
    readonly step: string;
    readonly status: number | undefined;
    constructor(step: string, status: number | undefined, cause: unknown);
}
/** The legacy single password secret: a reader password too, removed with the others. */
export declare const LEGACY_READER_PASSWORD_SECRET = "NARRARIUM_READER_PASSWORD";
/** The Pages site of the repository, or null when Pages is off. */
export declare function readPagesSite(request: GitHubRequest, repository: RepositoryRef): Promise<PagesSite | null>;
export type WorkflowState = "active" | "paused" | "missing" | string;
/** The state of the Pages workflow: `active`, `paused` (disabled by hand or by `disablePagesSite`), `missing`, or what GitHub says. */
export declare function readPagesWorkflowState(request: GitHubRequest, repository: RepositoryRef, workflowFile?: string): Promise<WorkflowState>;
export interface EnablePagesResult {
    /** `created`: Pages turned on; `already-on`: it was, built by Actions; `switched-to-workflow`: it was on, built from a branch, and now by Actions. */
    pages: "created" | "already-on" | "switched-to-workflow";
    workflow: "resumed" | "active" | "missing";
    site: PagesSite | null;
}
/** Turns Pages on, built by GitHub Actions (`build_type: workflow`), and resumes the Pages workflow if it was paused. */
export declare function enablePagesSite(request: GitHubRequest, repository: RepositoryRef, options?: {
    workflowFile?: string;
}): Promise<EnablePagesResult>;
export interface DisablePagesOptions {
    /** Pause the Pages workflow too (default): a push would otherwise run a build that fails without a site. */
    pauseWorkflow?: boolean;
    /** The explicit second choice: delete READER_PASSWORD_SECRETS and every reader password secret (the listed ones and NARRARIUM_READER_PASSWORD). */
    removePasswords?: boolean;
    workflowFile?: string;
}
export interface DisablePagesResult {
    pages: "disabled" | "already-off";
    workflow: "paused" | "kept" | "missing";
    variable: "deleted" | "kept" | "missing";
    /** The password secrets deleted. */
    removedSecrets: string[];
    /** What GitHub refused along the way (the steps after a refusal still run); empty when everything went through. */
    failures: Array<{
        step: string;
        status?: number;
    }>;
}
/**
 * Turns Pages off. By default the workflow file, the variable and the secrets stay (the workflow is only paused); with `removePasswords`
 * the variable is deleted first (so no build ever lists a secret that is gone), then the secrets.
 */
export declare function disablePagesSite(request: GitHubRequest, repository: RepositoryRef, options?: DisablePagesOptions): Promise<DisablePagesResult>;
/** The names READER_PASSWORD_SECRETS lists, or null when the variable does not exist. */
export declare function readReaderPasswordNames(request: GitHubRequest, repository: RepositoryRef): Promise<string[] | null>;
/**
 * Writes READER_PASSWORD_SECRETS (created when missing); an empty list deletes it, which makes the book public at the next build. The
 * secrets themselves are written by the caller (a sealed box with the repository's public key) BEFORE the list names them, and deleted
 * AFTER the list stops naming them, so that no build ever lists a secret that is not there.
 */
export declare function writeReaderPasswordNames(request: GitHubRequest, repository: RepositoryRef, names: string[]): Promise<"created" | "updated" | "deleted" | "unchanged">;
/** Runs the Pages workflow now (after a change of the passwords, or to publish again). */
export declare function dispatchPagesWorkflow(request: GitHubRequest, repository: RepositoryRef, options: {
    ref: string;
    workflowFile?: string;
}): Promise<void>;
export interface PagesRun {
    id: number;
    status: string | null;
    conclusion: string | null;
    htmlUrl: string | null;
    createdAt: string | null;
    event: string | null;
    headSha: string | null;
}
/** The latest run of the Pages workflow, or null when it never ran (or the file is missing). */
export declare function readLatestPagesRun(request: GitHubRequest, repository: RepositoryRef, workflowFile?: string): Promise<PagesRun | null>;
//# sourceMappingURL=pages-lifecycle.d.ts.map