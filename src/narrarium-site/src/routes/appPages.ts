import { withAutopilotTranslations } from "@/i18n/autopilot";

/**
 * The modules of the pages of the app beyond its first page, loaded when they are opened.
 *
 * Vite turns every `import()` into a call that first asks for everything the imported chunk needs (the chunk, the chunks it imports and its CSS,
 * all at once, so that they come in parallel and not one after the other), and it writes the list of those files in the chunk where the call is.
 * When the router imported every page, the lists of all of them were in the entry, which every route loads, the public home included: each new
 * page made every route heavier, by 150 to 250 bytes (more for a page that needs more files). Here they are in a chunk of their own, which the
 * router asks for together with the shell of the app and when a page of it is opened directly: a page keeps its preloading, the entry keeps only
 * the lists of the routes of a first visit (the public pages, the sign-in and the return from GitHub, the shell and its first page, the books), and
 * a new page costs the other routes its route object, about 35 bytes.
 *
 * A new page of the app goes here, and in the router as `appPage("Name")`. `test/routePreload.test.mjs` and the check of the entry in
 * `scripts/assert-production-bundle.mjs` hold the rule.
 */
const settingsPage = () => import("@/pages/SettingsPage");

export const appPages = {
  AccountSyncPage: () => import("@/pages/AccountSyncPage"),
  AddBookPage: withAutopilotTranslations(() => import("@/pages/AddBookPage")),
  AppDocsPage: () => import("@/pages/AppDocsPage"),
  AppNotFoundPage: () => import("@/pages/AppNotFoundPage"),
  AssetGalleryPage: () => import("@/pages/AssetGalleryPage"),
  AssistantChatsPage: () => import("@/pages/AssistantChatsPage"),
  AuditPage: () => import("@/pages/AuditPage"),
  AutopilotHubPage: withAutopilotTranslations(() => import("@/pages/AutopilotHubPage")),
  AutopilotPage: withAutopilotTranslations(() => import("@/pages/AutopilotPage")),
  AutopilotSettingsPage: withAutopilotTranslations(() => import("@/pages/AutopilotSettingsPage")),
  BookDashboardPage: () => import("@/pages/BookDashboardPage"),
  BrainstormerPage: () => import("@/pages/BrainstormerPage"),
  BookExportPage: () => import("@/pages/BookExportPage"),
  BookPage: () => import("@/pages/BookPage"),
  BookSettingsPage: () => import("@/pages/BookSettingsPage"),
  CanonEntityPage: () => import("@/pages/CanonEntityPage"),
  ChapterAnnotationsPage: () => import("@/pages/ChapterAnnotationsPage"),
  BookAnnotationsPage: () => import("@/pages/BookAnnotationsPage"),
  ChapterPage: () => import("@/pages/ChapterPage"),
  CostsPage: () => import("@/pages/CostsPage"),
  CustomActionsPage: () => import("@/pages/CustomActionsPage"),
  DeepResearchPage: () => import("@/pages/DeepResearchPage"),
  DirectorPage: withAutopilotTranslations(() => import("@/pages/DirectorPage")),
  EvaluationStylePage: () => import("@/pages/EvaluationStylePage"),
  GhostwritersPage: () => import("@/pages/GhostwritersPage"),
  MigratePage: () => import("@/pages/MigratePage"),
  OutlinePage: () => import("@/pages/OutlinePage"),
  ParagraphPage: () => import("@/pages/ParagraphPage"),
  ParagraphSplitPage: () => import("@/pages/ParagraphSplitPage"),
  PatchNotesPage: () => import("@/pages/PatchNotesPage"),
  ReaderEvaluationsPage: () => import("@/pages/ReaderEvaluationsPage"),
  ReaderPersonasPage: () => import("@/pages/ReaderPersonasPage"),
  ReaderPreviewPage: () => import("@/pages/ReaderPreviewPage"),
  ReaderSettingsPage: () => import("@/pages/ReaderSettingsPage"),
  SettingsPage: settingsPage,
  // The settings of the personal server show the state of the books on it, in the texts of the autopilot.
  SettingsPageWithAutopilotTexts: withAutopilotTranslations(settingsPage),
  StageRoutes: () => import("@/routes/StageRoutes"),
  WildcardsPage: () => import("@/pages/WildcardsPage"),
  WorkspaceDocPage: () => import("@/pages/WorkspaceDocPage"),
} satisfies Record<string, () => Promise<object>>;

export type AppPages = typeof appPages;
export type AppPageName = keyof AppPages;
