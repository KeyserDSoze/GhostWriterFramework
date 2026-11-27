import { z } from "zod";
import { toolData, type ScopedToolOutcome } from "@/assistant/scopedTools";
import { pageViewText } from "@/assistant/pages/view";
import type { PageCapability, PageEnv, PageTool } from "@/assistant/pages/types";

/**
 * The Assets page with the Copilot: it sees the images of the book (the cover, the image of each chapter and scene) with which exist and which do not, and
 * their prompts, and what the page filters; it reads the list whole. Making an image is the page's own dialog (it shows the prompt and the cost first), so the
 * Copilot says which images are missing and where to make them, and does not make them itself.
 */

const PROMPT = [
  "The author is on the Assets page of the book: its cover and the image of each chapter and scene, each with its prompt, made with the image model of the AI router.",
  "You do not make images yourself: on this page each card has its own action, which shows the prompt and asks before spending. Say which images are missing and how to make them.",
].join(" ");

interface Asset {
  kind: "book" | "chapter" | "paragraph";
  title: string;
  image: boolean;
  prompt: boolean;
}

/** The images of the book as the page lists them: the cover, then each chapter and its scenes. */
export function bookAssets(env: Pick<PageEnv, "structure" | "book">): Asset[] {
  const { structure } = env;
  return [
    { kind: "book", title: structure.title || env.book.name, image: Boolean(structure.bookCoverPath), prompt: Boolean(structure.bookCoverPromptPath) },
    ...structure.chapters.flatMap((chapter) => [
      { kind: "chapter" as const, title: chapter.title, image: Boolean(chapter.imagePath), prompt: Boolean(chapter.imagePromptPath) },
      ...chapter.paragraphs.map((paragraph) => ({ kind: "paragraph" as const, title: `${chapter.title} / ${paragraph.title}`, image: Boolean(paragraph.imagePath), prompt: Boolean(paragraph.imagePromptPath) })),
    ]),
  ];
}

function line(asset: Asset): string {
  return `- ${asset.kind} · ${asset.title} · ${asset.image ? "image" : "no image"}${asset.prompt ? " · prompt" : ""}`;
}

export function assetsStateText(assets: readonly Asset[], view: PageEnv["view"], max = 80): string {
  const missing = assets.filter((asset) => !asset.image).length;
  const looking = pageViewText(view);
  return [
    `Images: ${assets.length - missing} of ${assets.length} made (${missing} missing); the cover ${assets[0]?.image ? "is made" : "is missing"}.`,
    looking ? `On the page now: ${looking}.` : "",
    ...assets.slice(0, max).map(line),
    assets.length > max ? `… and ${assets.length - max} more (read_assets lists them all).` : "",
  ].filter(Boolean).join("\n");
}

const readAssets: PageTool = {
  id: "read_assets",
  description: "every image of the book (the cover, each chapter and scene) with whether it is made and has a prompt; \"missing\" lists only the ones not made",
  args: '{"missing"?:true}',
  schema: z.object({ missing: z.boolean().optional() }).strict() as never,
  async run(args: { missing?: boolean }, env: PageEnv): Promise<ScopedToolOutcome> {
    const assets = bookAssets(env).filter((asset) => !args.missing || !asset.image);
    return toolData("read_assets", assets.length ? assets.map(line).join("\n") : "Every image of the book is made.");
  },
};

export const assetsPage: PageCapability = {
  id: "assets",
  prompt: PROMPT,
  async state(env) {
    return assetsStateText(bookAssets(env), env.view);
  },
  tools: [readAssets],
};
