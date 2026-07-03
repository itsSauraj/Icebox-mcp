# Icebox MCP

One MCP server that hosts **different MCP Apps**, each with its own tool, UI
resource, and self-contained React bundle. A host (e.g. Claude Desktop) calls a
tool, renders that app's UI, and the app reports results back to the model.

All apps are built with **React** (via the SDK's `useApp` hook) and bundled into
single self-contained HTML files with Vite.

## The apps

| Tool | UI | What it does |
|------|----|--------------|
| `color-picker` | 🎨 | HSV area + hue/opacity sliders, HEX/RGB/HSL, swatches, eyedropper |
| `dice` | 🎲 | Roll 1–5 dice with total; **Duel** mode = You vs Opponent, highest total wins |
| `coin-flip` | 🪙 | Flip a coin with a 3D animation + running Heads/Tails tally |
| `draw-card` | 🃏 | Draw from a shuffled 52-card deck; auto-reshuffles |
| `spin-wheel` | 🎡 | Wheel-of-Fortune spinner with **editable labels — add as many as you want** |
| `decision-dice` | 🎲 | A die with **custom text faces** (Yes/No/Maybe…), fully editable |

Each tool accepts optional input to seed the UI (e.g. `color-picker` →
`{ "initialColor": "#2563eb" }`, `spin-wheel` → `{ "labels": ["Pizza","Tacos","Sushi"] }`,
`decision-dice` → `{ "faces": ["Yes","No"] }`, `dice` → `{ "count": 2 }`) and
returns a text + structured result for non-UI hosts.

## Project layout

Everything runnable lives in this directory:

```
*.html                 One HTML entry per app (color-picker.html, dice.html, …)
index.html             Dev-only launcher linking to every app's preview
server.ts              Registers all 6 tools + UI resources
main.ts                Local server — Streamable HTTP (default) or stdio (--stdio)
api/mcp.ts             Vercel serverless function exposing the MCP endpoint
vercel.json            Vercel config (static pages + /mcp rewrite)
public/                Base-domain pages: index.html, privacy.html, terms.html, styles.css
scripts/bundle-html.mjs   Inlines built app HTML → generated/html.js
generated/html.js      Inlined app HTML (generated; imported by server.ts)
src/
  lib/
    runtime.tsx        Shared MCP App runtime: connect, theming, preview, reporting
    ui.module.css      Shared component styles
    rng.ts             randInt / pick / shuffle
    color.ts           Color-conversion helpers
  color-picker/        each app: index.tsx (entry) + its .module.css
  dice/  coin/  card/  wheel/  decision-dice/
  global.css           Base styles + host style-variable fallbacks
dist/                  Built single-file HTML per app (generated)
```

Adding another app = one HTML entry + one `src/<name>/index.tsx` calling
`renderApp(...)` + one `serveHtml`/`registerAppTool` pair in `server.ts` + one
line in `build:apps` + one line in `scripts/bundle-html.mjs`.

## Pages served on the base domain

The server also serves plain web pages alongside the MCP endpoint (needed for app
submission, which requires a privacy policy URL):

| Path | Page |
|------|------|
| `/` | Landing page describing the apps |
| `/privacy` | Privacy Policy |
| `/terms` | Terms of Service |
| `/mcp` | The MCP endpoint (unchanged) |

Locally these come from `public/` via Express static (`npm run serve` →
`http://localhost:3001/`). On Vercel they're served as static files. Edit the
placeholder contact email in `public/privacy.html` and `public/terms.html`
before submitting.

## Setup

```bash
npm install
```

## Preview the UIs locally (no MCP host)

Every app detects a top-level browser tab and renders in **standalone preview
mode** with a stubbed host, so you can design and click around without an agent.

```bash
npm run dev:ui      # Vite dev server + hot-reload; opens the launcher at /
```

The launcher (`index.html`) links to each app; or open one directly, e.g.
`http://localhost:5173/wheel.html`.

## Run the MCP server

```bash
npm start                       # build all apps + start HTTP server on :3001/mcp
npm run build && npm run serve:stdio   # stdio transport (subprocess hosts)
```

`npm run build` bundles all six apps into `dist/`, then inlines them into
`generated/html.js`. `npm run serve` reads that module (no filesystem at runtime),
so build first (or use `npm start`). Set `PORT` to change the port (default `3001`).

## Deploy to Vercel

The server is serverless-ready:

- App HTML is **inlined** at build time (`generated/html.js`) — no runtime
  filesystem access, so it works in a Vercel Function.
- The transport is **stateless** (`sessionIdGenerator: undefined`) — no session
  storage or sticky routing needed.
- [api/mcp.ts](api/mcp.ts) is the Function (reuses the same transport as local);
  [vercel.json](vercel.json) rewrites `/mcp` → `/api/mcp` and serves `public/`.

Deployment (you run these — accounts/auth are yours):

```bash
npm i -g vercel     # if needed
vercel              # link + deploy a preview
vercel --prod       # production deploy
```

Vercel runs `vercel-build` (`build:apps` + `bundle:html`) automatically. After
deploy you get:

| URL | Purpose |
|-----|---------|
| `https://<app>.vercel.app/` | Landing page |
| `https://<app>.vercel.app/privacy` | Privacy Policy (use this in the submission) |
| `https://<app>.vercel.app/mcp` | **MCP connector URL** — point Claude/ChatGPT here |

Point your connector at `…/mcp` and drop the local tunnel. For submission, set
`APP_DOMAIN` in the Vercel project's Environment Variables (see below).

> Note: `@vercel/node` pulls in an `esbuild` postinstall. Deploys on Vercel's
> infra handle it; only if you run `vercel dev` locally may you need
> `npm approve-scripts esbuild`.

## Try it with the reference host

```bash
# Terminal 1
npm start

# Terminal 2 (from a clone of modelcontextprotocol/ext-apps)
cd examples/basic-host && npm install
SERVERS='["http://localhost:3001/mcp"]' npm run start
# open http://localhost:8080 and invoke any of the tools
```

## App submission (CSP + domain)

Each app's UI resource sets its metadata in `contents[]._meta.ui`:

- **`csp`** — a locked-down Content Security Policy (`connectDomains: []`,
  `resourceDomains: []`). These apps are fully self-contained (JS/CSS inlined,
  no network), so no external origins are allowed. Host-agnostic — the same
  policy is correct for Claude and OpenAI.
- **`domain`** — **omitted by default.** The sandbox domain is *computed by the
  host* from your server URL; you don't invent it. Declaring a value the host
  doesn't expect causes a `ui.domain mismatch` error, so omitting it lets each
  host use its own default origin. This is why **one running instance serves
  both Claude and OpenAI**.

For app submission, when a host requires the domain declared, set `APP_DOMAIN`
to the exact value that host expects — no rebuild, no separate instance:

```bash
npm start                                              # dev/runtime: domain omitted
APP_DOMAIN=<hash>.claudemcpcontent.com npm start       # declare it for submission
```

> Claude reports the expected value in the `ui.domain mismatch` error and its
> submission UI; OpenAI assigns one. It's tied to your specific server URL, so
> if the URL changes the host issues a new value. See [server.ts](server.ts).

## Connect from Claude Desktop (stdio)

Build once so `dist/*.html` exists, then add to your MCP servers config:

```json
{
  "mcpServers": {
    "color-picker-and-games": {
      "command": "npx",
      "args": ["tsx", "main.ts", "--stdio"],
      "cwd": "c:/Users/dev/Documents/PROJECTS/mcp-v2"
    }
  }
}
```

## How the shared runtime works

`src/lib/runtime.tsx` centralizes the boilerplate every app needs:

- Connects to the host with `useApp` and applies host theme / style variables / fonts.
- Exposes tool input, tool result, and host context to the app component.
- **Preview mode:** if the page is a top-level tab (`window.parent === window`),
  it renders immediately with a stub host instead of hanging on the MCP
  handshake. Inside a host the app runs in an iframe and connects normally.
- `reportResult()` sends the outcome to the model (`updateModelContext` +
  `sendMessage`); in preview these are no-ops.
