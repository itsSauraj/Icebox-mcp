import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
// App HTML is inlined at build time (scripts/bundle-html.mjs) so the server
// needs no runtime filesystem access — required for serverless (Vercel, etc.).
import { htmlByFile } from "./generated/html.js";

const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

// ---- App-submission metadata (per-resource CSP + sandbox domain) ----
//
// One instance serves BOTH Claude and OpenAI: the CSP below is host-agnostic,
// and the sandbox `domain` is COMPUTED BY THE HOST from your server URL — you
// don't invent it. Declaring a value that disagrees with the host triggers a
// "ui.domain mismatch" error, so by default we OMIT `domain` and each host uses
// its own default origin (which is why the same server works for both).
//
// Only set APP_DOMAIN for app submission, to the exact value the host expects
// (Claude reports it in the mismatch error / submission UI; OpenAI assigns one).
const APP_DOMAIN = process.env.APP_DOMAIN?.trim() || undefined;

/**
 * Register the UI resource for an app and return its resource URI. Each app
 * serves its own bundled single-file HTML from `dist/<htmlFile>` and declares
 * the CSP required for submission.
 */
function serveHtml(server: McpServer, name: string, htmlFile: string): string {
  const resourceUri = `ui://${name}/${htmlFile}`;
  registerAppResource(server,
    resourceUri,
    resourceUri,
    { mimeType: RESOURCE_MIME_TYPE },
    async (): Promise<ReadResourceResult> => {
      const html = htmlByFile[htmlFile];
      if (!html) throw new Error(`Missing bundled HTML for "${htmlFile}" — run \`npm run build\`.`);
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

const HEX_RE = /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const normalizeHex = (input?: string) =>
  input && HEX_RE.test(input.trim()) ? `#${input.trim().replace(/^#/, "").toLowerCase()}` : "#2563eb";

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];
const SUIT_NAME: Record<string, string> = { "♠": "Spades", "♥": "Hearts", "♦": "Diamonds", "♣": "Clubs" };
const WHEEL_DEFAULT = ["100", "200", "300", "400", "500", "Bankrupt", "600", "700", "800", "Free Spin"];
const FACES_DEFAULT = ["Yes", "No", "Maybe", "Definitely", "No way", "Ask again"];
const LOCAL_READONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
};

/**
 * Creates a new MCP server instance hosting the color picker plus a set of
 * mini-games — each registered as its own tool + UI resource.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "IceBox", version: "1.0.0" });

  // ---- Color picker ----
  const colorUri = serveHtml(server, "color-picker", "color-picker.html");
  registerAppTool(server, "color-picker", {
    title: "Color Picker",
    description: "Opens an interactive color picker, optionally seeded with a hex color. The user's chosen color is reported back.",
    inputSchema: { initialColor: z.string().regex(HEX_RE, "Must be a hex color like #2563eb").optional().describe("Initial color (hex).") },
    outputSchema: z.object({ color: z.string() }),
    annotations: LOCAL_READONLY_TOOL_ANNOTATIONS,
    _meta: { ui: { resourceUri: colorUri } },
  }, async ({ initialColor }): Promise<CallToolResult> => {
    const color = normalizeHex(initialColor);
    return { content: [{ type: "text", text: `Color picker opened at ${color}.` }], structuredContent: { color } };
  });

  // ---- Dice ----
  const diceUri = serveHtml(server, "dice", "dice.html");
  registerAppTool(server, "dice", {
    title: "Roll Dice",
    description: "Rolls one or more six-sided dice (default 1) and returns the faces and total. The UI supports re-rolling and a two-player 'highest total wins' duel.",
    inputSchema: { count: z.number().int().min(1).max(5).optional().describe("Number of dice to roll (1–5).") },
    outputSchema: z.object({ rolls: z.array(z.number()), total: z.number() }),
    annotations: LOCAL_READONLY_TOOL_ANNOTATIONS,
    _meta: { ui: { resourceUri: diceUri } },
  }, async ({ count }): Promise<CallToolResult> => {
    const n = count ?? 1;
    const rolls = Array.from({ length: n }, () => randInt(1, 6));
    const total = rolls.reduce((a, b) => a + b, 0);
    return { content: [{ type: "text", text: `Rolled ${rolls.join(", ")} (total ${total}).` }], structuredContent: { rolls, total } };
  });

  // ---- Coin flip ----
  const coinUri = serveHtml(server, "coin-flip", "coin.html");
  registerAppTool(server, "coin-flip", {
    title: "Flip a Coin",
    description: "Flips a fair coin and returns Heads or Tails.",
    inputSchema: {},
    outputSchema: z.object({ result: z.enum(["Heads", "Tails"]) }),
    annotations: LOCAL_READONLY_TOOL_ANNOTATIONS,
    _meta: { ui: { resourceUri: coinUri } },
  }, async (): Promise<CallToolResult> => {
    const result = Math.random() < 0.5 ? "Heads" : "Tails";
    return { content: [{ type: "text", text: `The coin landed on ${result}.` }], structuredContent: { result } };
  });

  // ---- Draw a card ----
  const cardUri = serveHtml(server, "draw-card", "card.html");
  registerAppTool(server, "draw-card", {
    title: "Draw a Card",
    description: "Draws a random card from a standard 52-card deck.",
    inputSchema: {},
    outputSchema: z.object({ rank: z.string(), suit: z.string(), label: z.string() }),
    annotations: LOCAL_READONLY_TOOL_ANNOTATIONS,
    _meta: { ui: { resourceUri: cardUri } },
  }, async (): Promise<CallToolResult> => {
    const rank = pick(RANKS), suit = pick(SUITS);
    const label = `${rank}${suit}`;
    return { content: [{ type: "text", text: `Drew the ${rank} of ${SUIT_NAME[suit]} (${label}).` }], structuredContent: { rank, suit, label } };
  });

  // ---- Spin the wheel ----
  const wheelUri = serveHtml(server, "spin-wheel", "wheel.html");
  registerAppTool(server, "spin-wheel", {
    title: "Spin the Wheel",
    description: "Spins a Wheel-of-Fortune style wheel. Provide custom labels (as many as you like) or use the defaults. Returns the winning label.",
    inputSchema: { labels: z.array(z.string()).min(2).max(24).optional().describe("Wheel segment labels (2–24).") },
    outputSchema: z.object({ labels: z.array(z.string()), winner: z.string(), index: z.number() }),
    annotations: LOCAL_READONLY_TOOL_ANNOTATIONS,
    _meta: { ui: { resourceUri: wheelUri } },
  }, async ({ labels }): Promise<CallToolResult> => {
    const segs = labels && labels.length >= 2 ? labels : WHEEL_DEFAULT;
    const index = randInt(0, segs.length - 1);
    const winner = segs[index];
    return { content: [{ type: "text", text: `The wheel landed on "${winner}".` }], structuredContent: { labels: segs, winner, index } };
  });

  // ---- Decision dice (custom labels) ----
  const decisionUri = serveHtml(server, "decision-dice", "decision-dice.html");
  registerAppTool(server, "decision-dice", {
    title: "Decision Dice",
    description: "Rolls a die with custom text faces (e.g. Yes/No/Maybe). Provide your own faces or use the defaults. Returns the chosen face.",
    inputSchema: { faces: z.array(z.string()).min(1).max(12).optional().describe("Custom die faces (1–12).") },
    outputSchema: z.object({ faces: z.array(z.string()), result: z.string() }),
    annotations: LOCAL_READONLY_TOOL_ANNOTATIONS,
    _meta: { ui: { resourceUri: decisionUri } },
  }, async ({ faces }): Promise<CallToolResult> => {
    const set = faces && faces.length ? faces : FACES_DEFAULT;
    const result = pick(set);
    return { content: [{ type: "text", text: `The decision die landed on "${result}".` }], structuredContent: { faces: set, result } };
  });

  return server;
}
