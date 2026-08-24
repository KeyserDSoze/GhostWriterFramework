import { ChapterStageIndexPage } from "@/pages/ChapterStageIndexPage";

export function DraftStageRoute() {
  return <ChapterStageIndexPage stage="drafts" />;
}

export function ScriptStageRoute() {
  return <ChapterStageIndexPage stage="scripts" />;
}
