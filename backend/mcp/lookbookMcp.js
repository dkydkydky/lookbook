// Shared Lookbook MCP server factory.
// Builds an McpServer with tools that wrap the Lookbook REST API. Used by both
// the stdio entrypoint (server.js) and the embedded HTTP connector
// (httpConnector.js). Read tools are always registered; write/upload/delete
// tools are opt-in via the `enableWrites` / `allowDelete` options.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
};

function toolResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function toolError(error) {
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${error?.message || String(error)}` }],
  };
}

/**
 * Create a configured Lookbook MCP server.
 * @param {object} opts
 * @param {string} opts.baseUrl        API base, e.g. http://localhost:4002/api
 * @param {number} [opts.timeoutMs]    per-request timeout
 * @param {boolean} [opts.enableWrites] register create/update/upload tools
 * @param {boolean} [opts.allowDelete]  register delete tools (requires enableWrites)
 * @param {object} [opts.auth]         { token, username, password } for admin routes
 */
export function createLookbookMcpServer(opts = {}) {
  const baseUrl = (opts.baseUrl || "http://localhost:4002/api").replace(/\/+$/, "");
  const timeoutMs = Number(opts.timeoutMs || 15000);
  const enableWrites = Boolean(opts.enableWrites);
  const allowDelete = Boolean(opts.allowDelete);
  const auth = opts.auth || {};

  let cachedToken = auth.token || null;

  async function getAuthToken() {
    if (cachedToken) return cachedToken;
    if (!auth.username || !auth.password) return null;
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: auth.username, password: auth.password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.token) {
      throw new Error(`Admin login failed (${res.status}): ${data?.error || "no token returned"}`);
    }
    cachedToken = data.token;
    return cachedToken;
  }

  async function apiFetch(pathname, { method = "GET", query, body, useAuth = false } = {}) {
    const url = new URL(`${baseUrl}${pathname}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        url.searchParams.set(key, Array.isArray(value) ? value.join(",") : String(value));
      }
    }

    const headers = {};
    if (body) headers["Content-Type"] = "application/json";
    if (useAuth) {
      const token = await getAuthToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      if (!res.ok) {
        throw new Error(
          `API ${method} ${url.pathname} failed (${res.status}): ${typeof parsed === "string" ? parsed : JSON.stringify(parsed)}`
        );
      }
      return parsed;
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveImageInput(value) {
    if (!value || typeof value !== "string") return value;
    if (value.startsWith("data:image/")) return value;
    if (/^https?:\/\//i.test(value)) return value;

    const ext = path.extname(value).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      throw new Error(
        `Unsupported image type for "${value}". Use one of: ${Object.keys(MIME_BY_EXT).join(", ")}, a data URL, or an http(s) URL.`
      );
    }
    const buf = await readFile(value);
    return `data:${mime};base64,${buf.toString("base64")}`;
  }

  const server = new McpServer({ name: "lookbook", version: "1.2.0" });

  // ---- READ TOOLS ---------------------------------------------------------
  server.registerTool(
    "search",
    {
      title: "Search Lookbook",
      description:
        "Unified keyword search across people and projects in the Lookbook. Returns matching people and/or projects.",
      inputSchema: {
        q: z.string().describe("Search query (name, skill, keyword, etc.)"),
        type: z.enum(["all", "people", "projects"]).default("all"),
        skills: z.array(z.string()).optional(),
        sectors: z.array(z.string()).optional(),
        openToWork: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async (args) => {
      try {
        return toolResult(await apiFetch("/search", { method: "POST", body: args }));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "list_people",
    {
      title: "List people",
      description:
        "List people (profiles) with optional filtering by search text, skills, industries, and open-to-work status. Paginated.",
      inputSchema: {
        search: z.string().optional(),
        skills: z.array(z.string()).optional(),
        industries: z.array(z.string()).optional(),
        openToWork: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ search, skills, industries, openToWork, limit, offset }) => {
      try {
        return toolResult(
          await apiFetch("/profiles", { query: { search, skills, industries, openToWork, limit, offset } })
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_person",
    {
      title: "Get person by slug",
      description: "Fetch a single person's full profile by their slug (e.g. 'jane-doe').",
      inputSchema: { slug: z.string().describe("Profile slug, e.g. 'jane-doe'.") },
    },
    async ({ slug }) => {
      try {
        return toolResult(await apiFetch(`/profiles/${encodeURIComponent(slug)}`));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "list_projects",
    {
      title: "List projects",
      description:
        "List projects with optional filtering by search text, skills, sectors, and cohort. Paginated.",
      inputSchema: {
        search: z.string().optional(),
        skills: z.array(z.string()).optional(),
        sectors: z.array(z.string()).optional(),
        cohort: z.string().optional(),
        hasDemoVideo: z.boolean().optional(),
        includeParticipants: z.boolean().default(false),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      },
    },
    async ({ search, skills, sectors, cohort, hasDemoVideo, includeParticipants, limit, offset }) => {
      try {
        return toolResult(
          await apiFetch("/projects", {
            query: { search, skills, sectors, cohort, hasDemoVideo, includeParticipants, limit, offset },
          })
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "get_project",
    {
      title: "Get project by slug",
      description: "Fetch a single project (including participants) by its slug.",
      inputSchema: { slug: z.string().describe("Project slug, e.g. 'my-project'.") },
    },
    async ({ slug }) => {
      try {
        return toolResult(await apiFetch(`/projects/${encodeURIComponent(slug)}`));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "list_initiatives",
    {
      title: "List initiatives",
      description: "List initiatives / cohort groupings, each with a live project count.",
      inputSchema: {},
    },
    async () => {
      try {
        return toolResult(await apiFetch("/initiatives"));
      } catch (error) {
        return toolError(error);
      }
    }
  );

  server.registerTool(
    "list_taxonomy",
    {
      title: "List taxonomy (skills & industries)",
      description:
        "List the available skills and/or industries used to tag people and projects. Useful for building valid filters.",
      inputSchema: { kind: z.enum(["skills", "industries", "all"]).default("all") },
    },
    async ({ kind }) => {
      try {
        const out = {};
        if (kind === "skills" || kind === "all") out.skills = await apiFetch("/taxonomy/skills");
        if (kind === "industries" || kind === "all") out.industries = await apiFetch("/taxonomy/industries");
        return toolResult(out);
      } catch (error) {
        return toolError(error);
      }
    }
  );

  // ---- WRITE / UPLOAD TOOLS ----------------------------------------------
  if (enableWrites) {
    server.registerTool(
      "create_person",
      {
        title: "Create a person",
        description:
          "Create a new person (profile). `photo` may be a local file path (uploaded), a data URL, or an http(s) URL.",
        inputSchema: {
          slug: z.string().describe("URL slug, lowercase-with-hyphens. Required."),
          name: z.string().optional(),
          title: z.string().optional(),
          bio: z.string().optional(),
          skills: z.array(z.string()).optional(),
          industryExpertise: z.array(z.string()).optional(),
          openToWork: z.boolean().optional(),
          photo: z.string().optional(),
          linkedinUrl: z.string().optional(),
          githubUrl: z.string().optional(),
          websiteUrl: z.string().optional(),
          xUrl: z.string().optional(),
          featured: z.boolean().optional(),
        },
      },
      async ({ photo, ...fields }) => {
        try {
          const body = { ...fields };
          if (photo !== undefined) body.photoUrl = await resolveImageInput(photo);
          return toolResult(await apiFetch("/profiles", { method: "POST", body, useAuth: true }));
        } catch (error) {
          return toolError(error);
        }
      }
    );

    server.registerTool(
      "update_person",
      {
        title: "Update a person",
        description:
          "Update an existing person by slug. Only provided fields change. `photo` may be a local file path (uploaded), a data URL, or an http(s) URL.",
        inputSchema: {
          slug: z.string().describe("Slug of the person to update. Required."),
          name: z.string().optional(),
          title: z.string().optional(),
          bio: z.string().optional(),
          skills: z.array(z.string()).optional(),
          industryExpertise: z.array(z.string()).optional(),
          openToWork: z.boolean().optional(),
          photo: z.string().optional(),
          linkedinUrl: z.string().optional(),
          githubUrl: z.string().optional(),
          websiteUrl: z.string().optional(),
          xUrl: z.string().optional(),
          featured: z.boolean().optional(),
        },
      },
      async ({ slug, photo, ...fields }) => {
        try {
          const body = { ...fields };
          if (photo !== undefined) body.photo_url = await resolveImageInput(photo);
          return toolResult(
            await apiFetch(`/profiles/${encodeURIComponent(slug)}`, { method: "PUT", body, useAuth: true })
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );

    server.registerTool(
      "upload_person_photo",
      {
        title: "Upload a person's photo",
        description:
          "Set/replace a person's photo from a local image file path (or data URL / http URL). Uploads and optimizes on the server.",
        inputSchema: {
          slug: z.string(),
          image: z.string().describe("Local image path, data URL, or http(s) URL."),
        },
      },
      async ({ slug, image }) => {
        try {
          const photo_url = await resolveImageInput(image);
          return toolResult(
            await apiFetch(`/profiles/${encodeURIComponent(slug)}`, {
              method: "PUT",
              body: { photo_url },
              useAuth: true,
            })
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );

    server.registerTool(
      "create_project",
      {
        title: "Create a project",
        description:
          "Create a new project. Image fields (mainImage, cardBackground, partnerLogo, icon) accept a local file path (uploaded), data URL, or http(s) URL.",
        inputSchema: {
          slug: z.string(),
          title: z.string(),
          short_description: z.string().optional(),
          description: z.string().optional(),
          skills: z.array(z.string()).optional(),
          sectors: z.array(z.string()).optional(),
          cohort: z.string().optional(),
          mainImage: z.string().optional(),
          cardBackground: z.string().optional(),
          partnerLogo: z.string().optional(),
          icon: z.string().optional(),
        },
      },
      async ({ mainImage, cardBackground, partnerLogo, icon, ...fields }) => {
        try {
          const body = { ...fields };
          if (mainImage !== undefined) body.main_image_url = await resolveImageInput(mainImage);
          if (cardBackground !== undefined) body.card_background_url = await resolveImageInput(cardBackground);
          if (partnerLogo !== undefined) body.partner_logo_url = await resolveImageInput(partnerLogo);
          if (icon !== undefined) body.icon_url = await resolveImageInput(icon);
          return toolResult(await apiFetch("/projects", { method: "POST", body, useAuth: true }));
        } catch (error) {
          return toolError(error);
        }
      }
    );

    server.registerTool(
      "update_project",
      {
        title: "Update a project",
        description:
          "Update an existing project by slug. Only provided fields change. Image fields accept a local file path (uploaded), data URL, or http(s) URL.",
        inputSchema: {
          slug: z.string(),
          title: z.string().optional(),
          short_description: z.string().optional(),
          description: z.string().optional(),
          skills: z.array(z.string()).optional(),
          sectors: z.array(z.string()).optional(),
          cohort: z.string().optional(),
          mainImage: z.string().optional(),
          cardBackground: z.string().optional(),
          partnerLogo: z.string().optional(),
          icon: z.string().optional(),
        },
      },
      async ({ slug, mainImage, cardBackground, partnerLogo, icon, ...fields }) => {
        try {
          const body = { ...fields };
          if (mainImage !== undefined) body.main_image_url = await resolveImageInput(mainImage);
          if (cardBackground !== undefined) body.card_background_url = await resolveImageInput(cardBackground);
          if (partnerLogo !== undefined) body.partner_logo_url = await resolveImageInput(partnerLogo);
          if (icon !== undefined) body.icon_url = await resolveImageInput(icon);
          return toolResult(
            await apiFetch(`/projects/${encodeURIComponent(slug)}`, { method: "PUT", body, useAuth: true })
          );
        } catch (error) {
          return toolError(error);
        }
      }
    );

    if (allowDelete) {
      server.registerTool(
        "delete_person",
        {
          title: "Delete a person",
          description: "Permanently delete a person by slug. Destructive.",
          inputSchema: { slug: z.string() },
        },
        async ({ slug }) => {
          try {
            return toolResult(
              await apiFetch(`/profiles/${encodeURIComponent(slug)}`, { method: "DELETE", useAuth: true })
            );
          } catch (error) {
            return toolError(error);
          }
        }
      );

      server.registerTool(
        "delete_project",
        {
          title: "Delete a project",
          description: "Permanently delete a project by slug. Destructive.",
          inputSchema: { slug: z.string() },
        },
        async ({ slug }) => {
          try {
            return toolResult(
              await apiFetch(`/projects/${encodeURIComponent(slug)}`, { method: "DELETE", useAuth: true })
            );
          } catch (error) {
            return toolError(error);
          }
        }
      );
    }
  }

  return server;
}
