import { PAGES_WORKFLOW_FILE } from "./pages-workflow.js";
import { READER_PASSWORD_SECRETS_VARIABLE, formatReaderPasswordSecretNames, parseReaderPasswordSecretNames, } from "./lib/reader-secret-names.js";
export class PagesRequestError extends Error {
    step;
    status;
    constructor(step, status, cause) {
        super(`GitHub refused «${step}»${status ? ` (${status})` : ""}.`);
        this.step = step;
        this.status = status;
        this.name = "PagesRequestError";
        this.cause = cause;
    }
}
/** The legacy single password secret: a reader password too, removed with the others. */
export const LEGACY_READER_PASSWORD_SECRET = "NARRARIUM_READER_PASSWORD";
function statusOf(error) {
    const status = error?.status;
    return typeof status === "number" ? status : undefined;
}
function toSite(data) {
    const record = (data ?? {});
    const text = (value) => (typeof value === "string" ? value : null);
    return {
        buildType: text(record.build_type),
        url: text(record.url),
        htmlUrl: text(record.html_url),
        status: text(record.status),
        public: typeof record.public === "boolean" ? record.public : null,
        cname: text(record.cname),
    };
}
async function call(step, run, tolerated = []) {
    try {
        return await run();
    }
    catch (error) {
        const status = statusOf(error);
        if (status !== undefined && tolerated.includes(status))
            return { tolerated: status };
        throw new PagesRequestError(step, status, error);
    }
}
function isTolerated(value) {
    return Boolean(value && typeof value === "object" && "tolerated" in value);
}
/** The Pages site of the repository, or null when Pages is off. */
export async function readPagesSite(request, repository) {
    const response = await call("read Pages", () => request("GET /repos/{owner}/{repo}/pages", { ...repository }), [404]);
    return isTolerated(response) ? null : toSite(response.data);
}
/** The state of the Pages workflow: `active`, `paused` (disabled by hand or by `disablePagesSite`), `missing`, or what GitHub says. */
export async function readPagesWorkflowState(request, repository, workflowFile = PAGES_WORKFLOW_FILE) {
    const response = await call("read the Pages workflow", () => request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}", { ...repository, workflow_id: workflowFile }), [404]);
    if (isTolerated(response))
        return "missing";
    const state = String(response.data?.state ?? "");
    return state.startsWith("disabled") ? "paused" : state || "active";
}
/** Turns Pages on, built by GitHub Actions (`build_type: workflow`), and resumes the Pages workflow if it was paused. */
export async function enablePagesSite(request, repository, options = {}) {
    const workflowFile = options.workflowFile ?? PAGES_WORKFLOW_FILE;
    let pages = "created";
    let site = null;
    const created = await call("turn Pages on", () => request("POST /repos/{owner}/{repo}/pages", { ...repository, build_type: "workflow" }), [409]);
    if (isTolerated(created)) {
        site = await readPagesSite(request, repository);
        if (site && site.buildType !== "workflow") {
            await call("build Pages with Actions", () => request("PUT /repos/{owner}/{repo}/pages", { ...repository, build_type: "workflow" }));
            pages = "switched-to-workflow";
            site = { ...site, buildType: "workflow" };
        }
        else {
            pages = "already-on";
        }
    }
    else {
        site = toSite(created.data);
    }
    const state = await readPagesWorkflowState(request, repository, workflowFile);
    let workflow = state === "missing" ? "missing" : "active";
    if (state === "paused") {
        await call("resume the Pages workflow", () => request("PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable", { ...repository, workflow_id: workflowFile }));
        workflow = "resumed";
    }
    return { pages, workflow, site };
}
/**
 * Turns Pages off. By default the workflow file, the variable and the secrets stay (the workflow is only paused); with `removePasswords`
 * the variable is deleted first (so no build ever lists a secret that is gone), then the secrets.
 */
export async function disablePagesSite(request, repository, options = {}) {
    const workflowFile = options.workflowFile ?? PAGES_WORKFLOW_FILE;
    const result = { pages: "disabled", workflow: "kept", variable: "kept", removedSecrets: [], failures: [] };
    const attempt = async (step, run, tolerated = []) => {
        try {
            return await call(step, run, tolerated);
        }
        catch (error) {
            result.failures.push({ step, status: error instanceof PagesRequestError ? error.status : undefined });
            return undefined;
        }
    };
    if (options.pauseWorkflow !== false) {
        const paused = await attempt("pause the Pages workflow", () => request("PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/disable", { ...repository, workflow_id: workflowFile }), [404]);
        if (paused !== undefined)
            result.workflow = isTolerated(paused) ? "missing" : "paused";
    }
    const deleted = await call("turn Pages off", () => request("DELETE /repos/{owner}/{repo}/pages", { ...repository }), [404]);
    result.pages = isTolerated(deleted) ? "already-off" : "disabled";
    if (options.removePasswords) {
        let names = [];
        try {
            names = (await readReaderPasswordNames(request, repository)) ?? [];
        }
        catch (error) {
            result.failures.push({ step: "read READER_PASSWORD_SECRETS", status: error instanceof PagesRequestError ? error.status : undefined });
        }
        const removedVariable = await attempt("delete READER_PASSWORD_SECRETS", () => request("DELETE /repos/{owner}/{repo}/actions/variables/{name}", { ...repository, name: READER_PASSWORD_SECRETS_VARIABLE }), [404]);
        if (removedVariable !== undefined)
            result.variable = isTolerated(removedVariable) ? "missing" : "deleted";
        for (const name of [...new Set([...names, LEGACY_READER_PASSWORD_SECRET])]) {
            const removed = await attempt(`delete the secret ${name}`, () => request("DELETE /repos/{owner}/{repo}/actions/secrets/{secret_name}", { ...repository, secret_name: name }), [404]);
            if (removed !== undefined && !isTolerated(removed))
                result.removedSecrets.push(name);
        }
    }
    return result;
}
/** The names READER_PASSWORD_SECRETS lists, or null when the variable does not exist. */
export async function readReaderPasswordNames(request, repository) {
    const response = await call("read READER_PASSWORD_SECRETS", () => request("GET /repos/{owner}/{repo}/actions/variables/{name}", { ...repository, name: READER_PASSWORD_SECRETS_VARIABLE }), [404]);
    if (isTolerated(response))
        return null;
    return parseReaderPasswordSecretNames(String(response.data?.value ?? "")).names;
}
/**
 * Writes READER_PASSWORD_SECRETS (created when missing); an empty list deletes it, which makes the book public at the next build. The
 * secrets themselves are written by the caller (a sealed box with the repository's public key) BEFORE the list names them, and deleted
 * AFTER the list stops naming them, so that no build ever lists a secret that is not there.
 */
export async function writeReaderPasswordNames(request, repository, names) {
    const value = formatReaderPasswordSecretNames(names);
    if (!value) {
        const removed = await call("delete READER_PASSWORD_SECRETS", () => request("DELETE /repos/{owner}/{repo}/actions/variables/{name}", { ...repository, name: READER_PASSWORD_SECRETS_VARIABLE }), [404]);
        return isTolerated(removed) ? "unchanged" : "deleted";
    }
    const updated = await call("update READER_PASSWORD_SECRETS", () => request("PATCH /repos/{owner}/{repo}/actions/variables/{name}", { ...repository, name: READER_PASSWORD_SECRETS_VARIABLE, value }), [404]);
    if (!isTolerated(updated))
        return "updated";
    await call("create READER_PASSWORD_SECRETS", () => request("POST /repos/{owner}/{repo}/actions/variables", { ...repository, name: READER_PASSWORD_SECRETS_VARIABLE, value }));
    return "created";
}
/** Runs the Pages workflow now (after a change of the passwords, or to publish again). */
export async function dispatchPagesWorkflow(request, repository, options) {
    await call("run the Pages workflow", () => request("POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches", { ...repository, workflow_id: options.workflowFile ?? PAGES_WORKFLOW_FILE, ref: options.ref }));
}
/** The latest run of the Pages workflow, or null when it never ran (or the file is missing). */
export async function readLatestPagesRun(request, repository, workflowFile = PAGES_WORKFLOW_FILE) {
    const response = await call("read the runs of the Pages workflow", () => request("GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs", { ...repository, workflow_id: workflowFile, per_page: 1 }), [404]);
    if (isTolerated(response))
        return null;
    const run = (response.data?.workflow_runs ?? [])[0];
    if (!run)
        return null;
    const text = (value) => (typeof value === "string" ? value : null);
    return {
        id: Number(run.id),
        status: text(run.status),
        conclusion: text(run.conclusion),
        htmlUrl: text(run.html_url),
        createdAt: text(run.created_at),
        event: text(run.event),
        headSha: text(run.head_sha),
    };
}
//# sourceMappingURL=pages-lifecycle.js.map