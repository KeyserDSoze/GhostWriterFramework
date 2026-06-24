import OpenAI, { AzureOpenAI } from "openai";
import { stringify } from "yaml";
import type { AIIntegration, AppSettings } from "@/types/settings";
import { createFile, createOrUpdateBinaryFile, readFileWithSha, updateFile } from "@/github/githubClient";
import { resolveWritingIntegration } from "@/assistant/llm";

export type AssetSubjectKind = "book" | "chapter" | "paragraph";
export type AssetPromptSource = "custom" | "text" | "resume";
export type AssetOrientation = "portrait" | "landscape" | "square";

export interface AssetTarget {
  subject: string;
  assetKind: string;
  assetId: string;
  directory: string;
  markdownPath: string;
  imagePath: string;
}

export function buildAssetTarget(input: {
  kind: AssetSubjectKind;
  chapterSlug?: string;
  paragraphSlug?: string;
  extension?: string;
}): AssetTarget {
  const extension = (input.extension ?? "png").replace(/^\./, "").toLowerCase();
  if (input.kind === "book") {
    return {
      subject: "book",
      assetKind: "cover",
      assetId: "asset:book:cover",
      directory: "assets/book",
      markdownPath: "assets/book/cover.md",
      imagePath: `assets/book/cover.${extension}`,
    };
  }
  if (input.kind === "chapter" && input.chapterSlug) {
    return {
      subject: `chapter:${input.chapterSlug}`,
      assetKind: "primary",
      assetId: `asset:chapter:${input.chapterSlug}:primary`,
      directory: `assets/chapters/${input.chapterSlug}`,
      markdownPath: `assets/chapters/${input.chapterSlug}/primary.md`,
      imagePath: `assets/chapters/${input.chapterSlug}/primary.${extension}`,
    };
  }
  if (input.kind === "paragraph" && input.chapterSlug && input.paragraphSlug) {
    return {
      subject: `paragraph:${input.chapterSlug}:${input.paragraphSlug}`,
      assetKind: "primary",
      assetId: `asset:paragraph:${input.chapterSlug}:${input.paragraphSlug}:primary`,
      directory: `assets/chapters/${input.chapterSlug}/paragraphs/${input.paragraphSlug}`,
      markdownPath: `assets/chapters/${input.chapterSlug}/paragraphs/${input.paragraphSlug}/primary.md`,
      imagePath: `assets/chapters/${input.chapterSlug}/paragraphs/${input.paragraphSlug}/primary.${extension}`,
    };
  }
  throw new Error("Invalid asset target.");
}

export function renderAssetMarkdown(input: {
  target: AssetTarget;
  prompt: string;
  orientation: AssetOrientation;
  aspectRatio: string;
  altText?: string;
  caption?: string;
  provider?: string;
  model?: string;
}): string {
  const frontmatter = {
    type: "asset",
    id: input.target.assetId,
    subject: input.target.subject,
    asset_kind: input.target.assetKind,
    path: input.target.imagePath,
    alt_text: input.altText || undefined,
    caption: input.caption || undefined,
    prompt_style_ref: "guideline:images",
    orientation: input.orientation,
    aspect_ratio: input.aspectRatio,
    provider: input.provider,
    model: input.model,
    canon: "draft",
  };
  return `---\n${stringify(frontmatter).trimEnd()}\n---\n\n${input.prompt.trim() ? input.prompt.trim() : "# Prompt\n"}\n`;
}

export async function saveAssetMarkdown(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  content: string;
}): Promise<void> {
  const existing = await readFileWithSha(input.token, input.owner, input.repo, input.branch, input.path).catch(() => null);
  if (existing) {
    await updateFile(input.token, input.owner, input.repo, input.branch, input.path, existing.sha, input.content, `Update asset prompt ${input.path}`);
  } else {
    await createFile(input.token, input.owner, input.repo, input.branch, input.path, input.content, `Add asset prompt ${input.path}`);
  }
}

export async function saveAssetImage(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  bytes: Uint8Array;
}): Promise<void> {
  await createOrUpdateBinaryFile(input.token, input.owner, input.repo, input.branch, input.path, input.bytes, `Update asset image ${input.path}`);
}

export async function generateAssetImage(input: {
  settings: AppSettings;
  prompt: string;
  orientation: AssetOrientation;
}): Promise<{ bytes: Uint8Array; provider: string; model: string }> {
  const integration = resolveWritingIntegration(input.settings);
  if (!integration || integration.provider === "m365_copilot") throw new Error("Image generation requires an OpenAI or Azure OpenAI integration.");
  if (!integration.apiKey) throw new Error("Missing API key for image generation.");
  const model = integration.modelImageGeneration?.trim() || "gpt-image-1";
  const client = createImageClient(integration);
  const response = await client.images.generate({
    model,
    prompt: input.prompt,
    n: 1,
    size: imageSize(input.orientation),
    output_format: "png",
    response_format: model === "gpt-image-1" ? undefined : "b64_json",
  } as never);
  const image = response.data?.[0];
  if (image?.b64_json) return { bytes: base64ToBytes(image.b64_json), provider: integration.provider, model };
  if (image?.url) {
    const fetched = await fetch(image.url);
    if (!fetched.ok) throw new Error(`Image download failed: ${fetched.status}`);
    return { bytes: new Uint8Array(await fetched.arrayBuffer()), provider: integration.provider, model };
  }
  throw new Error("Image provider returned no image.");
}

function createImageClient(integration: AIIntegration): AzureOpenAI | OpenAI {
  return integration.provider === "azure_openai"
    ? new AzureOpenAI({ endpoint: integration.endpoint ?? "", apiKey: integration.apiKey, apiVersion: integration.apiVersion || "2024-10-21", dangerouslyAllowBrowser: true })
    : new OpenAI({ apiKey: integration.apiKey, baseURL: integration.endpoint || "https://api.openai.com/v1", dangerouslyAllowBrowser: true });
}

function imageSize(orientation: AssetOrientation): "1024x1024" | "1536x1024" | "1024x1536" {
  if (orientation === "landscape") return "1536x1024";
  if (orientation === "square") return "1024x1024";
  return "1024x1536";
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
