/**
 * The GitHub Pages workflow of a Narrarium book, and the upgrade of the one an existing repository has. No import of Node here: the
 * Narrarium site (in a browser) and the scaffolders (in Node) use the same text.
 *
 * In a book repository the workflow that runs is `.github/workflows/deploy-reader-pages.yml` at the ROOT (the reader lives in `reader/`);
 * the reader's own `reader/.github/workflows/deploy-pages.yml` is only for a reader kept as a repository of its own, and GitHub never runs
 * it inside a book. Both come from `buildPagesWorkflow`.
 *
 * Passwords: the repository variable READER_PASSWORD_SECRETS lists the names of the secrets that hold them. Secrets cannot be indexed by a
 * variable in an expression, so the build step, and only it, receives `${{ toJSON(secrets) }}`; the reader's build reads the listed names
 * and nothing else, and never prints a value (see `src/lib/reader-passwords.ts`).
 */
export declare const PAGES_WORKFLOW_FILE = "deploy-reader-pages.yml";
export declare const PAGES_WORKFLOW_PATH = ".github/workflows/deploy-reader-pages.yml";
/** The workflow of a reader that is a repository of its own. */
export declare const READER_PAGES_WORKFLOW_PATH = ".github/workflows/deploy-pages.yml";
/** The version this file writes; the first line of the workflow says it, so that a later upgrade knows which text it wrote. */
export declare const PAGES_WORKFLOW_VERSION = 2;
export interface PagesWorkflowOptions {
    /** Where the reader is, from the root of the repository: `reader` in a book (the default), `.` for a reader that is its own repository. */
    readerDir?: string;
    /** A custom domain: the site is then served from `/`. */
    pagesDomain?: string;
    /** setup-node's npm cache, which needs `<readerDir>/package-lock.json` in the repository (the default for the CLI). */
    npmCache?: boolean;
    /**
     * The secret of the single password of the books published before the list (`NARRARIUM_READER_PASSWORD: ${{ secrets.<name> }}`): kept,
     * it stays one of the passwords of the book. Only an upgrade that found it in the workflow sets it.
     */
    legacyPasswordSecret?: string;
}
/** The workflow text for these options. */
export declare function buildPagesWorkflow(options?: PagesWorkflowOptions): string;
export type PagesWorkflowStatus = "missing" | "current" | "generated" | "customized";
export interface PagesWorkflowUpgrade {
    /**
     * `missing`: the repository has no workflow; `current`: it already has this version (nothing to commit); `generated`: it has a workflow
     * Narrarium wrote and nobody changed (apart from the single password line, which is kept); `customized`: it has edits this function
     * cannot merge, listed in `customizations`.
     */
    status: PagesWorkflowStatus;
    /** True when `text` can be committed after the author sees it (missing, generated). Never true for `customized`: that needs «replace my edits». */
    safe: boolean;
    /** The text to commit: for `customized`, the replacement that would drop the edits. */
    text: string;
    /** What the repository's workflow says, carried into `text`. */
    settings: {
        readerDir: string;
        pagesDomain?: string;
        npmCache: boolean;
        legacyPasswordSecret?: string;
    };
    /** In plain words, what committing `text` changes (for the dialog and the body of the commit). */
    changes: string[];
    /** For `customized`: the lines of the repository's workflow that no workflow of Narrarium has (`+`), and the ones it lacks (`-`). */
    customizations: string[];
    /** The path of the file in the repository. */
    path: string;
}
/**
 * What to commit to bring a repository's Pages workflow to this version, from the text it has now (`null`: no file). Nothing is committed
 * here: the caller shows `changes` (and, for a customized file, `customizations`) and commits `text` as a commit of its own only when the
 * author asks. The single password of an older book (`NARRARIUM_READER_PASSWORD: ${{ secrets.X }}`) is kept as it is, so that the book
 * stays protected by it.
 */
export declare function planPagesWorkflowUpgrade(existing: string | null | undefined, options?: PagesWorkflowOptions): PagesWorkflowUpgrade;
//# sourceMappingURL=pages-workflow.d.ts.map