import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/drive/useSettings";
import { createTrackedGitHubClient } from "@/repository/githubRequest";
import type { CreateCompleteBookRepositoryResult } from "@/github/bookRepository";
import type { ReaderFailure } from "@/readerAccess/errors";
import { protectionFailureOf, protectionStep, retryProtectedReader, type FirstReaderPassword } from "@/readerAccess/creation";
import type { GitHubRepositoryChoices } from "@/components/book/GitHubRepositoryPanel";

/** What the result of a creation shows about the reader's password. */
export interface ReaderSetupView {
  /** The first password, to show with Show / Copy. */
  password: FirstReaderPassword;
  status: "set" | "failed" | "retrying";
  failure?: ReaderFailure;
  /** Which part stopped: the password on GitHub, or the workflow that was held back. */
  stage?: "password" | "workflow";
  onRetry: () => void;
}

/** Whether a creation is to make a protected reader: Pages on, «protected» chosen and a password made (it is only made once the workflow can honour it). */
export function protectedReaderOf(choices: GitHubRepositoryChoices, label: string): FirstReaderPassword | null {
  return choices.pages && choices.reader === "protected" && choices.readerPassword ? { label, value: choices.readerPassword } : null;
}

/**
 * The first password of a protected reader through the creation of a repository: `step` goes in the creation as `beforeWorkflow`, `settle` reads the result of
 * the creation, and `view` is what the result shows (the password, whether it is on GitHub, what stopped it) with the retry that finishes the same password and
 * then lands the workflow that was held back.
 */
export function useProtectedReaderSetup(token: string) {
  const { t } = useTranslation();
  const { save } = useSettings();
  const [state, setState] = useState<{ password: FirstReaderPassword; status: "set" | "failed" | "retrying"; failure?: ReaderFailure; stage?: "password" | "workflow" } | null>(null);
  const secretName = useRef<string | undefined>(undefined);

  /** The step to pass as `beforeWorkflow`, or `undefined` when the reader is public. */
  function step(choices: GitHubRepositoryChoices) {
    const password = protectedReaderOf(choices, t("github.createBook.reader.firstLabel"));
    secretName.current = undefined;
    setState(password ? { password, status: "set" } : null);
    return password ? protectionStep(password, save, (name) => { secretName.current = name; }) : undefined;
  }

  /** Reads the result of the creation: a workflow that was held back means the password is not in place. */
  function settle(result: CreateCompleteBookRepositoryResult) {
    setState((current) => {
      if (!current) return current;
      if (result.beforeWorkflow?.status === "failed") return { ...current, status: "failed", failure: protectionFailureOf(result.beforeWorkflow.error), stage: "password" };
      return { ...current, status: "set", failure: undefined, stage: undefined };
    });
  }

  async function retry(result: CreateCompleteBookRepositoryResult, onResult: (next: CreateCompleteBookRepositoryResult) => void) {
    if (!state) return;
    setState({ ...state, status: "retrying" });
    const outcome = await retryProtectedReader({
      octokit: createTrackedGitHubClient(token),
      owner: result.owner,
      repo: result.repo,
      branch: result.defaultBranch,
      password: state.password,
      secretName: secretName.current,
      files: result.pendingWorkflow,
      save,
    });
    if (outcome.ok === true) {
      secretName.current = outcome.secretName;
      setState({ ...state, status: "set", failure: undefined, stage: undefined });
      onResult({ ...result, workflow: "done", pendingWorkflow: [], beforeWorkflow: { status: "done" } });
      return;
    }
    if (outcome.ok === false) {
      if (outcome.secretName) secretName.current = outcome.secretName;
      setState({ ...state, status: "failed", failure: outcome.failure, stage: outcome.stage });
    }
  }

  const view = (result: CreateCompleteBookRepositoryResult, onResult: (next: CreateCompleteBookRepositoryResult) => void): ReaderSetupView | undefined => state ? { ...state, onRetry: () => void retry(result, onResult) } : undefined;

  return { step, settle, view };
}
