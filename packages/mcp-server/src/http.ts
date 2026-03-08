#!/usr/bin/env node

import { createServer } from "node:http";
import { handlePublicMcpRequest } from "./public-http-server.js";

const port = Number(process.env.PORT || process.env.MCP_PORT || 3000);

const server = createServer(async (req, res) => {
  if (req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.url === "/mcp" || req.url === "/api/mcp") {
    await handlePublicMcpRequest(req, res);
    return;
  }

  res.statusCode = 404;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, () => {
  console.log(`GhostWriter public MCP listening on http://localhost:${port}/mcp`);
  console.log(`Health check available on http://localhost:${port}/health`);
});
