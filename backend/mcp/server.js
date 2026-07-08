#!/usr/bin/env node
// Lookbook MCP server — stdio entrypoint (for Claude Desktop / Cursor).
// Tool definitions live in ./lookbookMcp.js so the same set can also be served
// over HTTP by the embedded remote connector (./httpConnector.js).
//
// Configuration (env vars):
//   BASE_URL                API base, default http://localhost:4002/api
//   REQUEST_TIMEOUT_MS      per-request timeout, default 15000
//   LOOKBOOK_ENABLE_WRITES  set to "true" to register write/upload tools
//   LOOKBOOK_ALLOW_DELETE   set to "true" to also register delete tools
//   ADMIN_TOKEN             pre-issued admin JWT (optional)
//   ADMIN_USERNAME          admin username for auto-login (optional)
//   ADMIN_PASSWORD          admin password for auto-login (optional)

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLookbookMcpServer } from "./lookbookMcp.js";

const enableWrites = String(process.env.LOOKBOOK_ENABLE_WRITES).toLowerCase() === "true";
const allowDelete = String(process.env.LOOKBOOK_ALLOW_DELETE).toLowerCase() === "true";
const baseUrl = process.env.BASE_URL || "http://localhost:4002/api";

const server = createLookbookMcpServer({
  baseUrl,
  timeoutMs: Number(process.env.REQUEST_TIMEOUT_MS || 15000),
  enableWrites,
  allowDelete,
  auth: {
    token: process.env.ADMIN_TOKEN,
    username: process.env.ADMIN_USERNAME,
    password: process.env.ADMIN_PASSWORD,
  },
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr so we don't corrupt the stdio JSON-RPC channel on stdout.
  console.error(
    `Lookbook MCP server running (BASE_URL=${baseUrl.replace(/\/+$/, "")}, writes=${enableWrites ? "on" : "off"}${
      enableWrites && allowDelete ? ", delete=on" : ""
    })`
  );
}

main().catch((error) => {
  console.error("Fatal error starting Lookbook MCP server:", error);
  process.exit(1);
});
