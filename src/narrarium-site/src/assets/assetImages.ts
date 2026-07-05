import OpenAI, { AzureOpenAI } from "openai";
import { parseDocument, stringify } from "yaml";
import type { AIIntegration, AppSettings } from "@/types/settings";
import { createFile, createOrUpdateBinaryFile, loadBinaryFileContent, readFileWithSha, updateFile } from "@/github/githubClient";
import { completeTextRouted, resolveTaskCandidates } from "@/assistant/router";
import { imageTokenDelta, useCostsStore } from "@/costs/costsStore";
import { useLlmDebugStore } from "@/debug/llmDebugStore";

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

export interface ExistingAssetImage {
  prompt: string;
  altText: string;
  caption: string;
  orientation: AssetOrientation;
  aspectRatio: string;
  imagePath?: string;
  imageBytes?: Uint8Array;
  mimeType?: string;
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

export async function loadExistingAssetImage(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  target: AssetTarget;
}): Promise<ExistingAssetImage | null> {
  const existing = await readFileWithSha(input.token, input.owner, input.repo, input.branch, input.target.markdownPath).catch(() => null);
  if (!existing) return null;
  const parsed = parseAssetMarkdown(existing.content);
  const imagePath = parsed.path || input.target.imagePath;
  const extension = imagePath.split(".").pop()?.toLowerCase() || "png";
  const bytes = await loadBinaryFileContent(input.token, input.owner, input.repo, imagePath, input.branch).catch(() => null);
  return {
    prompt: parsed.body,
    altText: parsed.altText,
    caption: parsed.caption,
    orientation: parsed.orientation,
    aspectRatio: parsed.aspectRatio,
    imagePath,
    imageBytes: bytes ?? undefined,
    mimeType: imageMimeType(extension),
  };
}

export async function composeAssetPromptWithAI(input: {
  settings: AppSettings;
  kind: AssetSubjectKind;
  title: string;
  sourceText: string;
}): Promise<string | null> {
  const answer = await completeTextRouted(input.settings, [
    {
      role: "system",
      content: "Write a single polished image-generation prompt for a Narrarium book asset. Return only markdown with a '# Prompt' heading and the prompt text. Include visual subject, mood, composition, continuity notes, orientation, and aspect ratio. Do not mention hidden spoilers unless present in the source text.",
    },
    {
      role: "user",
      content: `Asset kind: ${input.kind}\nTitle: ${input.title}\nSource text:\n${input.sourceText.slice(0, 6000)}`,
    },
  ], "default", { label: "image:prompt" }).catch(() => "");
  return answer.trim() || null;
}

export async function generateAssetImage(input: {
  settings: AppSettings;
  prompt: string;
  orientation: AssetOrientation;
}): Promise<{ bytes: Uint8Array; provider: string; model: string }> {
  const candidates = resolveTaskCandidates(input.settings, "image").filter((c) => c.integration && c.model && c.integration.apiKey);
  if (!candidates.length) throw new Error("Image generation requires an OpenAI or Azure OpenAI integration.");
  let lastError: unknown = null;
  for (const candidate of candidates) {
    const integration = candidate.integration!;
    const model = candidate.model!;
    const client = createImageClient(integration);
    const debugId = useLlmDebugStore.getState().begin({ kind: "image", label: "image", model, messages: [{ role: "input", content: input.prompt }] });
    try {
      const response = await client.images.generate({
        model,
        prompt: input.prompt,
        n: 1,
        size: imageSize(input.orientation),
        output_format: "png",
        response_format: model === "gpt-image-1" ? undefined : "b64_json",
      } as never);
      const cost = recordImageUsage(integration, response);
      useLlmDebugStore.getState().finish(debugId, { status: "done", response: `${imageSize(input.orientation)} png`, cost });
      const image = response.data?.[0];
      if (image?.b64_json) return { bytes: base64ToBytes(image.b64_json), provider: integration.provider, model };
      if (image?.url) {
        const fetched = await fetch(image.url);
        if (!fetched.ok) throw new Error(`Image download failed: ${fetched.status}`);
        return { bytes: new Uint8Array(await fetched.arrayBuffer()), provider: integration.provider, model };
      }
      throw new Error("Image provider returned no image.");
    } catch (err) {
      useLlmDebugStore.getState().finish(debugId, { status: "error", error: err instanceof Error ? err.message : String(err) });
      lastError = err;
      // try next image fallback candidate
    }
  }
  throw lastError ?? new Error("Image generation failed.");
}

function createImageClient(integration: AIIntegration): AzureOpenAI | OpenAI {
  return integration.provider === "azure_openai"
    ? new AzureOpenAI({ endpoint: integration.endpoint ?? "", apiKey: integration.apiKey, apiVersion: integration.apiVersion || "2024-10-21", dangerouslyAllowBrowser: true })
    : new OpenAI({ apiKey: integration.apiKey, baseURL: integration.endpoint || "https://api.openai.com/v1", dangerouslyAllowBrowser: true });
}

function recordImageUsage(integration: AIIntegration, response: unknown): number | undefined {
  const pricing = integration.pricing;
  if (!pricing) return undefined;
  const usage = (response as { usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_text_tokens?: number; cached_image_tokens?: number; cached_tokens?: number } } }).usage;
  const details = usage?.input_tokens_details;
  if (usage && (usage.output_tokens || usage.input_tokens)) {
    const inputText = details?.text_tokens ?? usage.input_tokens ?? 0;
    const inputImage = details?.image_tokens ?? 0;
    const delta = imageTokenDelta({
      inputTextTokens: inputText,
      cachedInputTextTokens: details?.cached_text_tokens ?? 0,
      inputImageTokens: inputImage,
      cachedInputImageTokens: details?.cached_image_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    }, pricing);
    useCostsStore.getState().recordCurrent(delta);
    return delta.imageCost;
  }
  // No token usage returned: count the image without a cost.
  useCostsStore.getState().recordCurrent({ imageCount: 1 });
  return undefined;
}

function parseAssetMarkdown(raw: string): {
  body: string;
  path: string;
  altText: string;
  caption: string;
  orientation: AssetOrientation;
  aspectRatio: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(raw);
  const frontmatter = match ? ((parseDocument(match[1]).toJSON() as Record<string, unknown> | null) ?? {}) : {};
  const body = (match ? match[2] : raw).trim();
  return {
    body,
    path: typeof frontmatter.path === "string" ? frontmatter.path : "",
    altText: typeof frontmatter.alt_text === "string" ? frontmatter.alt_text : "",
    caption: typeof frontmatter.caption === "string" ? frontmatter.caption : "",
    orientation: frontmatter.orientation === "landscape" || frontmatter.orientation === "square" ? frontmatter.orientation : "portrait",
    aspectRatio: typeof frontmatter.aspect_ratio === "string" ? frontmatter.aspect_ratio : "2:3",
  };
}

function imageMimeType(extension: string): string {
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "gif") return "image/gif";
  return "image/png";
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
