import DOMPurify from "dompurify";
import { marked } from "marked";

const SAFE_TAGS = [
  "a", "blockquote", "br", "code", "del", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "ol", "p", "pre", "strong",
  "table", "tbody", "td", "th", "thead", "tr", "ul",
];

const SAFE_ATTRIBUTES = ["href", "title", "colspan", "rowspan"];

const EXTERNAL_RESOURCE_SCHEME = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function isApprovedRepositoryAssetPath(path: string): boolean {
  const clean = path.trim().replace(/^['"]|['"]$/g, "");
  return Boolean(clean) && !EXTERNAL_RESOURCE_SCHEME.test(clean) && !clean.startsWith("#");
}

export function sanitizeRepositoryHtml(html: string): string {
  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: SAFE_TAGS,
    ALLOWED_ATTR: SAFE_ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["audio", "canvas", "embed", "form", "iframe", "img", "math", "object", "script", "style", "svg", "video"],
    FORBID_ATTR: ["style"],
  });
  if (typeof DOMParser === "undefined") return sanitized;
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  for (const link of document.querySelectorAll("a")) {
    const rawHref = link.getAttribute("href") ?? "";
    const href = rawHref.replace(/[\u0000-\u0020\u007f]+/g, "").trim();
    if (!/^(?:https?:|mailto:|#|\/|\.\.?(?:\/|$))/i.test(href)) link.removeAttribute("href");
    else {
      link.setAttribute("href", href);
      link.setAttribute("rel", "noopener noreferrer nofollow");
      if (/^https?:/i.test(href)) link.setAttribute("target", "_blank");
    }
  }
  return document.body.innerHTML;
}

export function renderRepositoryMarkdownHtml(markdown: string): string {
  return sanitizeRepositoryHtml(marked.parse(markdown, { async: false }) as string);
}

export function renderEpubMarkdownHtml(markdown: string, packagedResources: ReadonlySet<string> = new Set()): string {
  const sanitized = DOMPurify.sanitize(marked.parse(markdown, { async: false }) as string, {
    ALLOWED_TAGS: [...SAFE_TAGS, "figure", "figcaption", "img"],
    ALLOWED_ATTR: [...SAFE_ATTRIBUTES, "alt", "src"],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ["audio", "canvas", "embed", "form", "iframe", "math", "object", "script", "style", "svg", "video"],
    FORBID_ATTR: ["style"],
  });
  if (typeof DOMParser === "undefined") return sanitized;
  const document = new DOMParser().parseFromString(sanitized, "text/html");
  for (const image of document.querySelectorAll("img")) {
    const src = image.getAttribute("src") ?? "";
    if (!isApprovedRepositoryAssetPath(src) || !packagedResources.has(src)) image.remove();
  }
  for (const link of document.querySelectorAll("a")) {
    const href = (link.getAttribute("href") ?? "").trim();
    if (!(href.startsWith("#") || (isApprovedRepositoryAssetPath(href) && packagedResources.has(href)))) link.removeAttribute("href");
  }
  return new XMLSerializer().serializeToString(document.body).replace(/^<body[^>]*>|<\/body>$/g, "");
}
