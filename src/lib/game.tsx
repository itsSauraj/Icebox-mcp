/**
 * @file Shared game shell. Every Icebox game is built from these primitives.
 *
 * Extracted from the original Snake app, which grew rough versions of all of
 * them inline. Three groups live here:
 *
 *  - **Loops.** `useGameLoop` for discrete games that advance on a fixed tick
 *    (Snake, Tetris), `useFrameLoop` for continuous ones that integrate over
 *    real time (Flappy, Breakout). Both run on `requestAnimationFrame`, never
 *    `setInterval`, which gets throttled and jittery inside a host iframe.
 *  - **Input.** Keyboard, swipe, and an on-screen d-pad, all normalised to the
 *    same `Direction` union so a game wires up one handler for three devices.
 *  - **Chrome.** Frame, header, overlay, control bar, segmented control. These
 *    give thirty apps one visual identity without constraining the board.
 *
 * Handlers are held in refs and refreshed every render, so a game can close
 * over fresh state without restarting its loop on every keystroke.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type TouchEvent,
} from "react";
import { tellModel, updateContext, useFlash, useFullscreen, type Runtime } from "./runtime";
import ui from "./ui.module.css";
import g from "./game.module.css";

export type Direction = "up" | "down" | "left" | "right";

/**
 * The status every game reports. `ready` is pre-first-input, `won` is a
 * distinct terminal state from `over` so the overlay can celebrate rather than
 * commiserate. Games without a win condition simply never use it.
 */
export type GameStatus = "ready" | "playing" | "paused" | "over" | "won";

export const isTerminal = (s: GameStatus) => s === "over" || s === "won";

/** Custom-property styles (CSS vars) typed as CSSProperties. */
export const sv = (o: Record<string, string | number>): CSSProperties =>
  o as unknown as CSSProperties;

/** Clamp helper, used by nearly every game that moves something. */
export const clamp = (n: number, lo: number, hi: number) => (n < lo ? lo : n > hi ? hi : n);

/* ------------------------------------------------------------------ */
/* Loops                                                               */
/* ------------------------------------------------------------------ */

/** Keep a callback in a ref that refreshes each render (no stale closures). */
function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  });
  return ref;
}

/**
 * Fixed-timestep loop. `onTick` fires exactly once per `tickMs` of elapsed
 * time, catching up after a stall (capped at 10 ticks so a backgrounded tab
 * cannot produce a thousand-step burst on return).
 *
 * The loop restarts only when `running` or `tickMs` changes, so speed changes
 * are cheap and state changes are free.
 */
export function useGameLoop(running: boolean, tickMs: number, onTick: () => void): void {
  const cb = useLatest(onTick);
  useEffect(() => {
    if (!running || tickMs <= 0) return;
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const loop = (now: number) => {
      let dt = now - last;
      last = now;
      if (dt > 250) dt = 250;
      acc += dt;
      let guard = 0;
      while (acc >= tickMs && guard < 10) {
        acc -= tickMs;
        guard++;
        cb.current();
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, tickMs, cb]);
}

/**
 * Per-frame loop for continuous motion. `onFrame` receives elapsed
 * milliseconds, clamped to 250 so a stall does not teleport anything through a
 * wall. Integrate against the delta, never assume 60fps.
 */
export function useFrameLoop(running: boolean, onFrame: (dtMs: number) => void): void {
  const cb = useLatest(onFrame);
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = performance.now();
    const loop = (now: number) => {
      let dt = now - last;
      last = now;
      if (dt > 250) dt = 250;
      cb.current(dt);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [running, cb]);
}

/**
 * Countdown timer in whole seconds. Returns the remaining count and a reset
 * function. Used by every timed game (Quiz Duel, Aim Trainer, Emoji Riddle).
 */
export function useCountdown(seconds: number, running: boolean, onExpire?: () => void) {
  const [left, setLeft] = useState(seconds);
  const expire = useLatest(onExpire);
  const fired = useRef(false);

  const reset = useCallback(
    (to = seconds) => {
      fired.current = false;
      setLeft(to);
    },
    [seconds],
  );

  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setLeft((n) => (n > 0 ? n - 1 : 0)), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  // `onExpire` fires from an effect, never from inside the state updater above.
  // React may invoke an updater more than once for the same transition, and
  // StrictMode deliberately does, so a side effect in there runs twice: a timed
  // game would score one timeout as two. The ref makes it once per round, and
  // `reset` re-arms it.
  useEffect(() => {
    if (!running || left > 0 || fired.current) return;
    fired.current = true;
    expire.current?.();
  }, [running, left, expire]);

  return [left, reset] as const;
}

/* ------------------------------------------------------------------ */
/* Input                                                               */
/* ------------------------------------------------------------------ */

const ARROW_KEYS: Record<string, Direction> = {
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  w: "up",
  s: "down",
  a: "left",
  d: "right",
};

/**
 * Bind arbitrary keys. Keys are matched lowercased, so pass `"escape"`,
 * `"z"`, `" "` and so on. Modifier chords are ignored, typing inside a field
 * is ignored, and Space or Enter on a focused button falls through to the
 * button so the on-screen controls keep working.
 */
export function useKeys(map: Record<string, () => void>, enabled = true): void {
  const ref = useLatest(map);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key.toLowerCase();
      if (tag === "BUTTON" && (k === " " || k === "enter")) return;
      const handler = ref.current[k];
      if (!handler) return;
      e.preventDefault();
      handler();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, ref]);
}

/**
 * Arrows and WASD to steer, Space to pause. The single most reused hook in the
 * catalogue: grid games, board games and paddle games all take the same four
 * directions.
 */
export function useDirectionKeys(
  onDirection: (dir: Direction) => void,
  onPause?: () => void,
  enabled = true,
): void {
  const dir = useLatest(onDirection);
  const pause = useLatest(onPause);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      const k = e.key.toLowerCase();
      const d = ARROW_KEYS[k];
      if (d) {
        e.preventDefault();
        dir.current(d);
        return;
      }
      if ((k === " " || k === "spacebar") && pause.current) {
        if (tag === "BUTTON") return;
        e.preventDefault();
        pause.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, dir, pause]);
}

/**
 * Swipe-to-direction handlers to spread onto the board element. Chained swipes
 * work because the origin resets on every recognised gesture. Pair with
 * `touch-action: none` in CSS so the host page does not scroll underneath.
 */
export function useSwipe(onDirection: (dir: Direction) => void, threshold = 20) {
  const start = useRef<{ x: number; y: number } | null>(null);
  const cb = useLatest(onDirection);

  return {
    onTouchStart: (e: TouchEvent) => {
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
    },
    onTouchMove: (e: TouchEvent) => {
      if (!start.current) return;
      const t = e.touches[0];
      const dx = t.clientX - start.current.x;
      const dy = t.clientY - start.current.y;
      if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;
      if (Math.abs(dx) > Math.abs(dy)) cb.current(dx > 0 ? "right" : "left");
      else cb.current(dy > 0 ? "down" : "up");
      start.current = { x: t.clientX, y: t.clientY };
    },
    onTouchEnd: () => {
      start.current = null;
    },
  };
}

/** Tap or click anywhere plus Space and Enter, for one-input games. */
export function useTapAnywhere(onTap: () => void, enabled = true): void {
  const cb = useLatest(onTap);
  useEffect(() => {
    if (!enabled) return;
    const fire = (e: Event) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT") return;
      e.preventDefault();
      cb.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Enter") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT") return;
      e.preventDefault();
      cb.current();
    };
    window.addEventListener("pointerdown", fire);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", fire);
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled, cb]);
}

/* ------------------------------------------------------------------ */
/* Seed data from the tool call                                        */
/* ------------------------------------------------------------------ */

/**
 * Everything the tool call sent, as one object.
 *
 * A hero game is launched by its own tool and reads `toolInput`. An arcade game
 * is launched through `play`, whose handler nests the per-game settings under
 * `structuredContent.config`. Merging all three here means a game never has to
 * care which way it was opened, and a game picked from the arcade menu simply
 * gets an empty object.
 *
 * Values arrive from the model, so treat every field as optional and check its
 * type before use. The handlers in `games/registry.ts` have already cleaned
 * anything they recognised.
 */
export function useSeed(runtime: Runtime): Record<string, unknown> {
  const input = runtime.toolInput;
  const structured = (runtime.toolResult?.structuredContent ?? undefined) as
    | Record<string, unknown>
    | undefined;
  const config = structured?.config as Record<string, unknown> | undefined;

  const inputKey = input ? JSON.stringify(input) : "";
  const structuredKey = structured ? JSON.stringify(structured) : "";

  const [seed, setSeed] = useState<Record<string, unknown>>({});
  useEffect(() => {
    setSeed({ ...(input ?? {}), ...(structured ?? {}), ...(config ?? {}) });
    // Comparing serialised values keeps the merge stable when the host resends
    // an identical notification, which some hosts do on reconnect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputKey, structuredKey]);

  return seed;
}

/** Read one string field out of the seed, falling back when absent or wrong. */
export function seedString(seed: Record<string, unknown>, key: string, fallback = ""): string {
  const v = seed[key];
  return typeof v === "string" && v ? v : fallback;
}

/** Read one number field out of the seed, clamped into range. */
export function seedNumber(seed: Record<string, unknown>, key: string, fallback: number, lo = -Infinity, hi = Infinity): number {
  const v = seed[key];
  return typeof v === "number" && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
}

/** Read an array field out of the seed, or an empty array. */
export function seedArray<T>(seed: Record<string, unknown>, key: string): T[] {
  const v = seed[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

/* ------------------------------------------------------------------ */
/* Score, reporting, sharing                                           */
/* ------------------------------------------------------------------ */

/**
 * Running best for the life of the mounted app.
 *
 * Deliberately in memory only. MCP Apps has no storage API, and
 * `localStorage` inside a host iframe may be partitioned or blocked outright,
 * so a best score that sometimes persists is worse than one that reliably does
 * not. Continuity across a conversation comes from the model instead, via
 * `useGameOverReport` below.
 */
export function useBest(score: number, higherIsBetter = true): number {
  const [best, setBest] = useState(score);
  useEffect(() => {
    setBest((b) => (higherIsBetter ? Math.max(b, score) : Math.min(b, score)));
  }, [score, higherIsBetter]);
  return best;
}

/**
 * Push a one-line result to the model exactly once per terminal state, and
 * re-arm when the game restarts.
 *
 * This is app-to-host only. It costs no model turn and no server round-trip,
 * which is what makes it the right place for every game-over summary. Use
 * `useShare` for anything that should actually speak up in the chat.
 */
export function useGameOverReport(
  runtime: Runtime,
  over: boolean,
  summary: () => string,
): void {
  const sent = useRef(false);
  const text = useLatest(summary);
  useEffect(() => {
    if (over && !sent.current) {
      sent.current = true;
      void updateContext(runtime, text.current());
    }
    if (!over) sent.current = false;
  }, [over, runtime, text]);
}

/**
 * Deliberate "tell the model" action. Returns the transient status line and the
 * trigger. This one does cost a model turn, so wire it to a button, never to
 * gameplay.
 */
export function useShare(runtime: Runtime): [string, (message: string, context?: string) => Promise<void>] {
  const [status, flash] = useFlash();
  const share = useCallback(
    async (message: string, context?: string) => {
      const ok = await tellModel(runtime, message, context);
      flash(runtime.standalone ? "Preview (not sent)" : ok ? "Sent to chat" : "Couldn't send");
    },
    [runtime, flash],
  );
  return [status, share];
}

/* ------------------------------------------------------------------ */
/* Chrome                                                              */
/* ------------------------------------------------------------------ */

/**
 * Root element for a game. Applies the host safe-area insets and the
 * fullscreen class. Give it the same ref you passed to `useFullscreen`.
 */
export function GameFrame({
  runtime,
  innerRef,
  fullscreen,
  wide,
  className = "",
  children,
}: {
  runtime: Runtime;
  innerRef: RefObject<HTMLDivElement | null>;
  fullscreen?: boolean;
  /** Opt into the wider column used by board and grid games. */
  wide?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const insets = runtime.hostContext?.safeAreaInsets;
  return (
    <div
      ref={innerRef}
      className={`${g.frame} ${wide ? g.wide : ""} ${fullscreen ? g.full : ""} ${className}`}
      style={{
        paddingTop: insets?.top,
        paddingRight: insets?.right,
        paddingBottom: insets?.bottom,
        paddingLeft: insets?.left,
      }}
    >
      {children}
    </div>
  );
}

export interface Stat {
  label: string;
  value: ReactNode;
}

/** Title, icon, and a row of labelled numbers. Identical across all games. */
export function GameHeader({
  title,
  icon,
  stats,
  hint,
}: {
  title: string;
  icon?: ReactNode;
  stats?: Stat[];
  hint?: ReactNode;
}) {
  return (
    <header className={g.header}>
      <h1 className={ui.title}>
        {icon}
        {title}
      </h1>
      {stats && stats.length > 0 && (
        <div className={g.stats}>
          {stats.map((s) => (
            <div key={s.label} className={g.stat}>
              <span className={g.statLabel}>{s.label}</span>
              <b className={g.statValue}>{s.value}</b>
            </div>
          ))}
        </div>
      )}
      {hint && <p className={ui.subtitle}>{hint}</p>}
    </header>
  );
}

/**
 * The panel that covers the board when the game is not running. One component
 * handles all four non-playing states so every game reads the same way.
 */
export function Overlay({
  status,
  title,
  detail,
  action,
  onAction,
  secondary,
  onSecondary,
  children,
}: {
  status: GameStatus;
  /** Headline. Defaults to a sensible phrase for the status. */
  title?: ReactNode;
  detail?: ReactNode;
  action?: string;
  onAction?: () => void;
  secondary?: string;
  onSecondary?: () => void;
  children?: ReactNode;
}) {
  if (status === "playing") return null;
  const heading =
    title ??
    (status === "over" ? "Game over" : status === "won" ? "You win" : status === "paused" ? "Paused" : "Ready");
  const banner = status === "won" ? ui.win : status === "over" ? ui.lose : ui.tie;

  return (
    <div className={g.overlay}>
      {isTerminal(status) ? (
        <span className={`${ui.banner} ${banner}`}>{heading}</span>
      ) : (
        <p className={g.overlayTitle}>{heading}</p>
      )}
      {detail && <p className={g.overlayDetail}>{detail}</p>}
      {children}
      <div className={ui.controls}>
        {action && onAction && (
          <button className={`${ui.btn} ${ui.primary}`} onClick={onAction}>
            {action}
          </button>
        )}
        {secondary && onSecondary && (
          <button className={ui.btn} onClick={onSecondary}>
            {secondary}
          </button>
        )}
      </div>
    </div>
  );
}

/** Row of buttons under the board. */
export function ControlBar({ children }: { children: ReactNode }) {
  return <div className={ui.controls}>{children}</div>;
}

/**
 * The standard trailing controls: pause, restart, fullscreen, share. Games
 * that need none of the four can compose `ControlBar` by hand instead.
 */
export function StandardControls({
  status,
  onPause,
  onRestart,
  onShare,
  shareLabel = "Tell the model",
}: {
  status: GameStatus;
  onPause?: () => void;
  onRestart: () => void;
  onShare?: () => void;
  shareLabel?: string;
}) {
  return (
    <ControlBar>
      {onPause && (
        <button className={`${ui.btn} ${ui.primary}`} onClick={onPause} disabled={isTerminal(status)}>
          {status === "playing" ? "Pause" : status === "paused" ? "Resume" : "Play"}
        </button>
      )}
      <button className={ui.btn} onClick={onRestart}>
        Restart
      </button>
      {onShare && (
        <button className={ui.btn} onClick={onShare} disabled={!isTerminal(status)}>
          {shareLabel}
        </button>
      )}
    </ControlBar>
  );
}

/** Pill group for difficulty, speed, mode. Mirrors the Snake speed selector. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[] | readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const items = options.map((o) =>
    typeof o === "string" ? { value: o, label: o[0].toUpperCase() + o.slice(1) } : o,
  ) as { value: T; label: string }[];
  return (
    <div className={g.seg} role="group" aria-label={label}>
      {items.map((o) => (
        <button
          key={o.value}
          className={`${g.segBtn} ${value === o.value ? g.segOn : ""}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const ROT: Record<Direction, number> = { up: 0, right: 90, down: 180, left: 270 };

export function Arrow({ dir, size = 22 }: { dir: Direction; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d="M12 5 L19 17 H5 Z" transform={`rotate(${ROT[dir]} 12 12)`} fill="currentColor" />
    </svg>
  );
}

/** On-screen direction pad. Essential on touch hosts, harmless on desktop. */
export function DPad({
  onDirection,
  hide,
}: {
  onDirection: (dir: Direction) => void;
  /** Omit the vertical arrows for paddle games that only move on one axis. */
  hide?: "vertical" | "horizontal";
}) {
  return (
    <div className={`${g.dpad} ${hide === "vertical" ? g.dpadFlat : ""}`} role="group" aria-label="Direction pad">
      {hide !== "vertical" && (
        <button className={`${g.dbtn} ${g.up}`} aria-label="Up" onClick={() => onDirection("up")}>
          <Arrow dir="up" />
        </button>
      )}
      {hide !== "horizontal" && (
        <button className={`${g.dbtn} ${g.left}`} aria-label="Left" onClick={() => onDirection("left")}>
          <Arrow dir="left" />
        </button>
      )}
      {hide !== "horizontal" && (
        <button className={`${g.dbtn} ${g.right}`} aria-label="Right" onClick={() => onDirection("right")}>
          <Arrow dir="right" />
        </button>
      )}
      {hide !== "vertical" && (
        <button className={`${g.dbtn} ${g.down}`} aria-label="Down" onClick={() => onDirection("down")}>
          <Arrow dir="down" />
        </button>
      )}
    </div>
  );
}

/** Transient status line, wired to `useShare`. */
export function StatusLine({ children }: { children: ReactNode }) {
  return (
    <p className={ui.status} role="status" aria-live="polite">
      {children}
    </p>
  );
}

/**
 * Shown when a content game is waiting on the model, or when the model sent
 * nothing usable and the app fell back to its own material.
 */
export function Notice({ children }: { children: ReactNode }) {
  return <p className={g.notice}>{children}</p>;
}

export { useFullscreen, useFlash };
export type { Runtime };
