// Embedded HTTP (Streamable HTTP) MCP connector for the Lookbook backend.
// Serves the same tools as the stdio server, but over HTTP so Claude can add it
// as a REMOTE connector. Intended to be mounted behind a secret URL path by
// backend/server.js. Read-only by default.
//
// Uses the SDK's StreamableHTTPServerTransport in stateless mode: a fresh
// server + transport is created per request, which keeps things simple and
// horizontally scalable (no server-side session state to share across nodes).

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createLookbookMcpServer } from "./lookbookMcp.js";

/**
 * Create an Express-compatible request handler for the MCP endpoint.
 * @param {object} opts
 * @param {string} opts.baseUrl        API base the tools call (e.g. http://localhost:4002/api)
 * @param {boolean} [opts.enableWrites] register write/upload tools (default false)
 * @param {boolean} [opts.allowDelete]  register delete tools (default false)
 * @param {object} [opts.auth]         { token, username, password } for admin routes
 * @returns {(req, res) => Promise<void>}
 */
export function createHttpHandler(opts = {}) {
  const { baseUrl, enableWrites = false, allowDelete = false, auth } = opts;

  return async function handleMcpRequest(req, res) {
    // Stateless: only POST carries JSON-RPC messages. GET (SSE) and DELETE
    // (session teardown) have nothing to do without sessions, so reject them.
    if (req.method !== "POST") {
      res.status(405).set("Allow", "POST").json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Method not allowed. Use POST." },
        id: null,
      });
      return;
    }

    const server = createLookbookMcpServer({ baseUrl, enableWrites, allowDelete, auth });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => {
      transport.close();
      server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
