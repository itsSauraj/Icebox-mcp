/**
 * @file Shared MCP App runtime used by every app in this server.
 *
 * Handles the parts that are identical across apps:
 *  - connecting to the host (`useApp`) and applying host theme/style/fonts
 *  - exposing tool input/result + host context to the app component
 *  - a standalone **preview** mode (top-level tab, no host) with a stub host so
 *    the UI is usable in a plain browser instead of hanging on "Connecting…"
 *  - helpers for reporting a result back to the model and flashing status text
 */
import {
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { createRoot } from "react-dom/client";
import ui from "./ui.module.css";

/** The minimal host surface the apps use to talk back to the model. */
export interface GameHost {
  updateModelContext(params: { content: Array<{ type: "text"; text: string }> }): Promise<unknown>;
  sendMessage(params: { role: "user"; content: Array<{ type: "text"; text: string }> }): Promise<{ isError?: boolean }>;
}

export interface Runtime {
  app: GameHost;
  hostContext?: McpUiHostContext;
  toolInput?: Record<string, unknown>;
  toolResult?: CallToolResult | null;
  standalone: boolean;
}

export interface AppProps {
  runtime: Runtime;
}

const NOOP_HOST: GameHost = {
  updateModelContext: async () => ({}),
  sendMessage: async () => ({ isError: false }),
};

/**
 * Silently keep the model aware of the latest result. This is app→host only
 * (no model turn, no server round-trip), so it's cheap to call on every action.
 */
export async function updateContext(runtime: Runtime, text: string): Promise<void> {
  try {
    await runtime.app.updateModelContext({ content: [{ type: "text", text }] });
  } catch (e) {
    console.error(e);
  }
}

/**
 * Explicitly send a chat message — this triggers a new model turn (and may cause
 * the host to call back into the server). Use only for deliberate "tell the
 * model" actions, not on every interaction.
 */
export async function tellModel(runtime: Runtime, message: string, context?: string): Promise<boolean> {
  try {
    if (context) await runtime.app.updateModelContext({ content: [{ type: "text", text: context }] });
    await runtime.app.sendMessage({ role: "user", content: [{ type: "text", text: message }] });
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

/** Transient status line: `flash("Sent!")` shows a message that clears itself. */
export function useFlash(): [string, (message: string) => void] {
  const [msg, setMsg] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const flash = useCallback((message: string) => {
    setMsg(message);
    if (timer.current) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(""), 1800);
  }, []);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return [msg, flash];
}

/** Page container that applies the host's safe-area insets. */
export function Shell({ runtime, children }: { runtime: Runtime; children: ReactNode }) {
  const insets = runtime.hostContext?.safeAreaInsets;
  return (
    <main
      className={ui.main}
      style={{
        paddingTop: insets?.top,
        paddingRight: insets?.right,
        paddingBottom: insets?.bottom,
        paddingLeft: insets?.left,
      }}
    >
      {children}
    </main>
  );
}

function HostRoot({
  appInfo,
  App,
}: {
  appInfo: { name: string; version: string };
  App: ComponentType<AppProps>;
}) {
  const [hostContext, setHostContext] = useState<McpUiHostContext | undefined>();
  const [toolInput, setToolInput] = useState<Record<string, unknown> | undefined>();
  const [toolResult, setToolResult] = useState<CallToolResult | null>(null);

  const { app, error } = useApp({
    appInfo,
    capabilities: {},
    onAppCreated: (a) => {
      a.onerror = console.error;
      a.onhostcontextchanged = (ctx) => setHostContext((prev) => ({ ...prev, ...ctx }));
      a.ontoolinput = (params) => setToolInput(params?.arguments as Record<string, unknown> | undefined);
      a.ontoolresult = (result) => setToolResult(result);
      a.onteardown = async () => ({});
    },
  });

  useEffect(() => {
    if (app) setHostContext(app.getHostContext());
  }, [app]);

  useEffect(() => {
    if (!hostContext) return;
    if (hostContext.theme) applyDocumentTheme(hostContext.theme);
    if (hostContext.styles?.variables) applyHostStyleVariables(hostContext.styles.variables);
    if (hostContext.styles?.css?.fonts) applyHostFonts(hostContext.styles.css.fonts);
  }, [hostContext]);

  if (error) return <div className={ui.notice}><strong>ERROR:</strong> {error.message}</div>;
  if (!app) return <div className={ui.notice}>Connecting…</div>;

  return <App runtime={{ app, hostContext, toolInput, toolResult, standalone: false }} />;
}

/**
 * Mount an app. In a host iframe it connects normally; as a top-level tab it
 * renders immediately in preview mode with a stub host.
 */
export function renderApp(
  appInfo: { name: string; version: string },
  App: ComponentType<AppProps>,
) {
  const isStandalone = window.parent === window;
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {isStandalone
        ? <App runtime={{ app: NOOP_HOST, standalone: true }} />
        : <HostRoot appInfo={appInfo} App={App} />}
    </StrictMode>,
  );
}
