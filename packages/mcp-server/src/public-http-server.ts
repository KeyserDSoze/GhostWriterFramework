import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  buildRepositorySpecSummary,
  buildSetupInstructions,
  fetchWikipediaPage,
  searchWikipedia,
} from "./public-tools.js";

export async function handlePublicMcpRequest(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
): Promise<void> {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  const server = createPublicMcpServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : "Internal server error",
          },
          id: null,
        }),
      );
    }
  }
}

export function createPublicMcpServer() {
  const server = new McpServer({
    name: "narrarium-public-http",
    version: "0.1.0",
  });

  server.tool(
    "setup_framework",
    "Return the exact npx commands and setup steps to bootstrap a new Narrarium project from scratch.",
    {
      projectName: z.string().optional(),
      title: z.string().optional(),
      language: z.string().default("en"),
      withReader: z.boolean().default(true),
      sample: z.boolean().default(false),
      readerDir: z.string().default("reader"),
    },
    async ({ projectName, title, language, withReader, sample, readerDir }) =>
      textResponse(
        buildSetupInstructions({
          projectName,
          title,
          language,
          withReader,
          sample,
          readerDir,
        }),
      ),
  );

  server.tool(
    "repository_spec",
    "Return the Narrarium repository model and canon rules so clients can understand the book framework structure.",
    {},
    async () => textResponse(buildRepositorySpecSummary()),
  );

  server.tool(
    "wikipedia_search",
    "Search English or Italian Wikipedia for historical or factual research.",
    {
      query: z.string().min(1),
      lang: z.enum(["en", "it"]).default("en"),
      limit: z.number().int().positive().max(10).default(5),
    },
    async ({ query, lang, limit }) => {
      const results = await searchWikipedia(query, lang, limit);

      if (results.length === 0) {
        return textResponse(`No Wikipedia matches found for \"${query}\" in ${lang}.`);
      }

      return textResponse(
        results
          .map((entry, index) => `${index + 1}. ${entry.title}\n   ${entry.snippet}\n   ${entry.url}`)
          .join("\n"),
      );
    },
  );

  server.tool(
    "wikipedia_page",
    "Fetch a Wikipedia page summary for setup or factual research.",
    {
      title: z.string().min(1),
      lang: z.enum(["en", "it"]).default("en"),
    },
    async ({ title, lang }) => {
      const page = await fetchWikipediaPage(title, lang);
      return textResponse(`${page.title}\n${page.description ?? ""}\n\n${page.extract}\n\n${page.url}`);
    },
  );

  return server;
}

function textResponse(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  };
}

function setCorsHeaders(res: ServerResponse) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,DELETE,OPTIONS");
  res.setHeader(
    "access-control-allow-headers",
    "content-type,mcp-session-id,last-event-id,mcp-protocol-version",
  );
  res.setHeader("access-control-expose-headers", "mcp-session-id,mcp-protocol-version");
}
