# Lookbook MCP Server

An [MCP](https://modelcontextprotocol.io) server that exposes the Lookbook REST
API as tools so **Claude** (Claude Desktop, Claude in Cursor, or the Claude API
via any MCP client) can search and read your Lookbook data in natural language.

By default it is **read-only**. Write/upload tools (create & update people and
projects, including image uploads) are opt-in via `LOOKBOOK_ENABLE_WRITES=true`.
It wraps the existing backend endpoints — it never touches the database directly.

## Read tools (always on)

| Tool | Wraps | What it does |
| --- | --- | --- |
| `search` | `POST /api/search` | Unified keyword search across people + projects |
| `list_people` | `GET /api/profiles` | List/filter people (search, skills, industries, openToWork) |
| `get_person` | `GET /api/profiles/:slug` | Full profile for one person |
| `list_projects` | `GET /api/projects` | List/filter projects (search, skills, sectors, cohort) |
| `get_project` | `GET /api/projects/:slug` | Full project incl. participants |
| `list_initiatives` | `GET /api/initiatives` | Cohorts / initiative groupings |
| `list_taxonomy` | `GET /api/taxonomy/*` | Available skills & industries (for building filters) |

## Write / upload tools (only when `LOOKBOOK_ENABLE_WRITES=true`)

| Tool | Wraps | What it does |
| --- | --- | --- |
| `create_person` | `POST /api/profiles` | Create a person; `photo` accepts a **local file path**, data URL, or http URL |
| `update_person` | `PUT /api/profiles/:slug` | Update a person (partial); same `photo` handling |
| `upload_person_photo` | `PUT /api/profiles/:slug` | Set/replace just the photo from a local file |
| `create_project` | `POST /api/projects` | Create a project; `mainImage`/`cardBackground`/`partnerLogo`/`icon` accept local paths |
| `update_project` | `PUT /api/projects/:slug` | Update a project (partial); same image handling |
| `delete_person` / `delete_project` | `DELETE ...` | Only if `LOOKBOOK_ALLOW_DELETE=true` (destructive) |

### How uploads work

Any image field accepts one of:

- **a local filesystem path** (e.g. `/Users/dy/Desktop/jane.jpg`) — the server
  reads it, base64-encodes it, and sends it to the API, which optimizes it into
  WebP (full-size + 400w) under `/uploads`. This is the "upload from my computer"
  path.
- a `data:image/...;base64,...` URL — passed through.
- an `http(s)://` URL — stored as-is.

Example prompt once writes are enabled: _"Create a person with slug jane-doe,
name Jane Doe, title Software Engineer, skills React and Node, and upload her
photo from /Users/dy/Desktop/jane.jpg."_

## Setup

```bash
cd backend/mcp
npm install
```

Requires Node 18+ (uses the global `fetch`).

The server talks to your running Lookbook API. Start the backend first
(`cd backend && npm run dev`, default port `4002`). The API base URL is
configurable via the `BASE_URL` env var and defaults to
`http://localhost:4002/api`.

Quick smoke test (Ctrl-C to stop — it waits for a client on stdio):

```bash
BASE_URL=http://localhost:4002/api node server.js
```

## Connect to Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "lookbook": {
      "command": "node",
      "args": ["/Users/dy/Projects/TWG/lookbook/backend/mcp/server.js"],
      "env": {
        "BASE_URL": "http://localhost:4002/api"
      }
    }
  }
}
```

Restart Claude Desktop. You should see the `lookbook` tools available, then ask
things like _"Search the lookbook for people who know React"_ or _"Show me the
project with slug my-project"_.

### Enabling uploads / writes

Add `LOOKBOOK_ENABLE_WRITES` and (optionally) admin credentials to the `env`
block. `ADMIN_USERNAME`/`ADMIN_PASSWORD` are only needed for admin-gated routes
(publish/unpublish and any future locked-down writes); the server auto-logs-in
and caches the JWT.

```json
{
  "mcpServers": {
    "lookbook": {
      "command": "node",
      "args": ["/Users/dy/Projects/TWG/lookbook/backend/mcp/server.js"],
      "env": {
        "BASE_URL": "http://localhost:4002/api",
        "LOOKBOOK_ENABLE_WRITES": "true",
        "ADMIN_USERNAME": "admin",
        "ADMIN_PASSWORD": "your-admin-password"
      }
    }
  }
}
```

Add `"LOOKBOOK_ALLOW_DELETE": "true"` as well if you also want delete tools
(destructive — off by default).

## Connect to Cursor

Add to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (this project):

```json
{
  "mcpServers": {
    "lookbook": {
      "command": "node",
      "args": ["/Users/dy/Projects/TWG/lookbook/backend/mcp/server.js"],
      "env": {
        "BASE_URL": "http://localhost:4002/api"
      }
    }
  }
}
```

## Remote connector (hosted over HTTPS)

Instead of running locally over stdio, you can let Claude connect to a **remote**
MCP endpoint served by the deployed backend itself. The backend exposes a
Streamable HTTP MCP endpoint at:

```
https://<your-backend-host>/mcp/<MCP_SECRET>
```

It is **read-only** and gated behind a secret URL segment (`MCP_SECRET`) so the
endpoint isn't guessable. The same 7 read tools are available.

### Enable it

1. Set a long random `MCP_SECRET` on the backend service (in Render:
   Dashboard → `lookbook-api` → Environment). `render.yaml` already declares the
   `MCP_SECRET` var (`sync: false`), so just fill in a value, e.g.:

   ```bash
   openssl rand -hex 24
   ```

2. Redeploy the backend. On boot you'll see
   `🔌 Remote MCP connector enabled at /mcp/<secret>` in the logs.

3. In Claude (Desktop or claude.ai) → **Settings → Connectors → Add custom
   connector**, paste the full URL including the secret:

   ```
   https://lookbook-api.onrender.com/mcp/<your-secret>
   ```

That's it — no local process, no config file. To rotate access, change
`MCP_SECRET` and redeploy.

### Related env vars (backend)

| Var | Default | Purpose |
| --- | --- | --- |
| `MCP_SECRET` | (unset → disabled) | Secret URL segment; enables the endpoint |
| `MCP_ENABLE_WRITES` | `false` | Expose write/upload tools remotely (not recommended for a public URL) |
| `MCP_ALLOW_DELETE` | `false` | Also expose delete tools (requires writes) |
| `MCP_BASE_URL` | `http://localhost:<PORT>/api` | API the tools call (self by default) |

> Security note: the remote endpoint is intentionally read-only. If you ever set
> `MCP_ENABLE_WRITES=true`, anyone who learns the secret URL can modify data —
> prefer keeping writes on the local stdio connector, or put the endpoint behind
> real OAuth.

## Pointing at production

Set `BASE_URL` to your deployed API (e.g. your Render backend URL ending in
`/api`). Because these are read endpoints, no auth token is required. If you
later add authenticated/write tools, gate them behind an env-provided token.
