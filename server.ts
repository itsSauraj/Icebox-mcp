import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { ALL_SPECS, READONLY_ANNOTATIONS, type ToolSpec } from "./games/registry.js";
// App HTML is inlined at build time (scripts/bundle-html.mjs) so the server
// needs no runtime filesystem access, which is required for serverless
// (Vercel, Workers). Each app is its own module and is imported on demand, so
// a cold start parses one app's HTML rather than all of them.
import { loadHtml } from "./generated/html/index.js";

// ---- App-submission metadata (per-resource CSP + sandbox domain) ----
//
// One instance serves BOTH Claude and OpenAI: the CSP below is host-agnostic,
// and the sandbox `domain` is COMPUTED BY THE HOST from your server URL, so you
// don't invent it. Declaring a value that disagrees with the host triggers a
// "ui.domain mismatch" error, so by default we OMIT `domain` and each host uses
// its own default origin (which is why the same server works for both).
//
// Only set APP_DOMAIN for app submission, to the exact value the host expects
// (Claude reports it in the mismatch error / submission UI; OpenAI assigns one).
const APP_DOMAIN = process.env.APP_DOMAIN?.trim() || undefined;

/**
 * Register the UI resource for one tool and return its resource URI. The URI is
 * derived from the tool name and its HTML file, which reproduces the URIs the
 * already-submitted apps use.
 */
function serveHtml(server: McpServer, name: string, htmlFile: string): string {
  const resourceUri = `ui://${name}/${htmlFile}`;
  registerAppResource(server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = await loadHtml(htmlFile);
      const uiMeta: Record<string, unknown> = {
        // These apps are fully self-contained (JS/CSS inlined, no network), so
        // no external origins are allowed. An explicit, locked-down policy
        // rather than the implicit default.
        csp: { connectDomains: [], resourceDomains: [] },
      };
      // Only declare a domain when explicitly provided for submission; otherwise
      // omit it so the host uses its own default origin (no mismatch).
      if (APP_DOMAIN) uiMeta.domain = APP_DOMAIN;

      return {
        contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html, _meta: { ui: uiMeta } }],
      };
    },
  );
  return resourceUri;
}

/** Register one tool from its registry entry, plus the UI resource it renders. */
function register(server: McpServer, spec: ToolSpec): void {
  const resourceUri = serveHtml(server, spec.name, spec.file);
  registerAppTool(server, spec.name, {
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    outputSchema: spec.outputSchema,
    annotations: READONLY_ANNOTATIONS,
    _meta: { ui: { resourceUri } },
  }, async (args): Promise<CallToolResult> => {
    const { text, data } = spec.run((args ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text", text }], structuredContent: data };
  });
}

/**
 * Creates a new MCP server instance hosting every Icebox app: the six original
 * mini apps, Wordle and Snake, six headline games with their own tools, and the
 * `play` tool that opens the rest of the arcade.
 *
 * The tool list comes from `games/registry.ts`, so adding a game means adding
 * one registry entry and one folder under `src/`, never editing this file.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "Icebox", version: "2.0.0" });
  for (const spec of ALL_SPECS) register(server, spec);
  return server;
}
