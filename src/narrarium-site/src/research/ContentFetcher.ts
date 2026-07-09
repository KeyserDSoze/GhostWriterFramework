import type { AppSettings } from "@/types/settings";
import type { FetchedContent, ResearchResult } from "./types";

function stripHtmlToText(html: string): string {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const text = doc.body?.textContent ?? "";
    return text.replace(/\s+/g, " ").trim();
  }
  return html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchViaProxy(baseUrl: string, url: string, signal?: AbortSignal): Promise<FetchedContent> {
  try {
    const endpoint = `${baseUrl.replace(/\/+$/, "")}?url=${encodeURIComponent(url)}`;
    const resp = await fetch(endpoint, { signal, headers: { Accept: "application/json, text/html;q=0.9, text/plain;q=0.8" } });
    if (!resp.ok) return { url, status: "proxy_failed", source: "cloudflare_proxy", error: String(resp.status) };
    const contentType = resp.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = await resp.json() as { finalUrl?: string; title?: string; text?: string; html?: string };
      const text = data.text ?? (data.html ? stripHtmlToText(data.html) : "");
      return { url, finalUrl: data.finalUrl, title: data.title, text, status: text ? "ok" : "proxy_failed", source: "cloudflare_proxy" };
    }
    const html = await resp.text();
    const text = stripHtmlToText(html);
    return { url, text, status: text ? "ok" : "proxy_failed", source: "cloudflare_proxy" };
  } catch (err) {
    return { url, status: "proxy_failed", source: "cloudflare_proxy", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function fetchContentForResult(settings: AppSettings, result: ResearchResult, signal?: AbortSignal): Promise<FetchedContent> {
  try {
    const resp = await fetch(result.url, { signal, headers: { Accept: "text/html, text/plain, application/xhtml+xml" } });
    if (!resp.ok) return { url: result.url, status: "blocked", source: "direct", error: String(resp.status) };
    const contentType = resp.headers.get("content-type") ?? "";
    const body = contentType.includes("text/plain") ? await resp.text() : stripHtmlToText(await resp.text());
    if (body.trim()) return { url: result.url, finalUrl: resp.url, text: body, status: "ok", source: "direct" };
    return { url: result.url, finalUrl: resp.url, status: "error", source: "direct", error: "Empty body" };
  } catch (err) {
    const proxyBase = settings.deepSearch.contentProxyBaseUrl?.trim() || (import.meta.env.VITE_RESEARCH_FETCH_PROXY as string | undefined)?.trim() || "";
    if (proxyBase) return fetchViaProxy(proxyBase, result.url, signal);
    return { url: result.url, status: "cors_failed", source: "direct", error: err instanceof Error ? err.message : String(err) };
  }
}
