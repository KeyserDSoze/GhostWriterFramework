import { expect, test } from "vitest";
import i18n from "@/i18n";
import { pillOfCopy, pillText, shownPill, type RepositoryPill } from "@/components/layout/repositoryPill";
import type { LocalRepoStatus, LocalRepositoryMeta } from "@/repository/localRepository";

// The pill of the repository in the top bar says what is true of the working copy on the screen: it is being read, it is not on this device, or what
// it holds; and when GitHub cannot be used with the book's credential, why the copy does not sync.

const t = i18n.t.bind(i18n);
const status = (dirty = 0, ahead = 0): LocalRepoStatus => ({ clean: 10, modified: dirty, new: 0, deleted: 0, dirty, ahead });
const meta = (extra: Partial<LocalRepositoryMeta> = {}) => ({ id: "repo", bookId: "book", owner: "owner", repo: "repo", branch: "main", cloneComplete: true, remoteStatus: "clean", lastFetchAt: "2026-11-27T07:00:00.000Z", ...extra }) as LocalRepositoryMeta;
const pill = (label: string, extra: Partial<RepositoryPill> = {}): RepositoryPill => ({ key: "book\nowner\nrepo\nmain\nworkspace:1", label, tone: "clean", copy: true, ...extra });

test("until the copy on the screen is read the pill says it is being checked, never that there is no copy", () => {
  const read = pill("Clean");
  expect(shownPill(read, read.key, t)).toBe(read);
  // Another book, branch or account: what was read for it is not shown for this one.
  expect(shownPill(read, "other\nowner\nrepo\nmain\nworkspace:1", t)).toMatchObject({ label: "Checking local copy…", copy: false });
  expect(shownPill({ key: "", label: "", tone: "none", copy: false }, read.key, t)).toMatchObject({ label: "Checking local copy…", tone: "offline" });
  expect(t("repoStatus.notCloned")).toBe("No local copy");
});

test("a copy that was read says its changes first, then how it stands with GitHub", () => {
  expect(pillOfCopy(meta(), status(2, 1), false, t)).toEqual({ label: "2 local changes", tone: "dirty" });
  expect(pillOfCopy(meta(), status(0, 1), false, t)).toEqual({ label: "1 local commits", tone: "ahead" });
  expect(pillOfCopy(meta({ cloneComplete: false }), status(), false, t)).toEqual({ label: t("repoStatus.incomplete"), tone: "behind" });
  expect(pillOfCopy(meta({ remoteStatus: "changed" }), status(), false, t)).toEqual({ label: t("repoStatus.behind"), tone: "behind" });
  expect(pillOfCopy(meta({ remoteStatus: "unverified", lastKnownChanged: true }), status(), false, t)).toEqual({ label: t("repoStatus.staleChanged"), tone: "offline" });
  expect(pillOfCopy(meta(), status(), false, t)).toEqual({ label: "Clean", tone: "clean" });
  // A book kept on this device: its commits are its saved history, not work waiting for GitHub.
  expect(pillOfCopy(meta(), status(0, 4), true, t)).toEqual({ label: t("localFirst.pillLocalOnly"), tone: "clean" });
});

test("a copy that cannot sync because of its GitHub credential says why after what it holds", () => {
  const read = pill("3 local changes", { tone: "dirty" });
  expect(pillText(read, { bookOnDevice: false, remote: "no-credential", token: "" }, t)).toBe("3 local changes · GitHub not connected");
  expect(pillText(read, { bookOnDevice: false, remote: "no-credential", token: "github_pat_expired" }, t)).toBe("3 local changes · sign in to GitHub again");
  expect(pillText(read, { bookOnDevice: false, remote: "ready", token: "github_pat_valid" }, t)).toBe("3 local changes");
  expect(pillText(read, { bookOnDevice: false, remote: "offline", token: "github_pat_valid" }, t)).toBe("3 local changes");
  // A book kept on this device has no GitHub to connect; a pill that read no copy has nothing to add.
  expect(pillText(read, { bookOnDevice: true, remote: "no-credential", token: "" }, t)).toBe("3 local changes");
  expect(pillText(pill("Checking local copy…", { copy: false, tone: "offline" }), { bookOnDevice: false, remote: "no-credential", token: "" }, t)).toBe("Checking local copy…");
});

test("the words of the pill exist in Italian", async () => {
  await i18n.changeLanguage("it");
  try {
    expect(shownPill({ key: "", label: "", tone: "none", copy: false }, "k", i18n.t.bind(i18n)).label).toBe("Controllo della copia locale…");
    expect(pillText(pill("Pulito"), { bookOnDevice: false, remote: "no-credential", token: "github_pat_expired" }, i18n.t.bind(i18n))).toBe("Pulito · accedi di nuovo a GitHub");
    expect(i18n.t("repoStatus.notCloned")).toBe("Nessuna copia locale");
  } finally {
    await i18n.changeLanguage("en");
  }
});
