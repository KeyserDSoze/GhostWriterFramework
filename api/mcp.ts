import type { IncomingMessage, ServerResponse } from "node:http";
import { handlePublicMcpRequest } from "../packages/mcp-server/src/public-http-server.js";

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse,
) {
  await handlePublicMcpRequest(req, res);
}

export const config = {
  api: {
    bodyParser: true,
  },
};
