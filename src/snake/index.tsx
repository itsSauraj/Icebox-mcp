/**
 * @file Classic grid Snake, rendered entirely with SVG. 🐍
 *
 * Move on a slow tick, eat food to grow, score = food eaten. Fully self-
 * contained (no network, no images) — food placement uses `Math.random` via
 * `randInt`. Controls: Arrow keys + WASD, on-board swipe, and an SVG D-pad;
 * Space (or a button) pauses. Walls can either end the game or wrap around.
 *
 * The live game lives in `gameRef` so the tick reads fresh state without stale
 * closures; `game` React state mirrors it for rendering. Committed direction is
 * held in `dirRef` (updated atomically with each committed frame) and validated
 * against on input, so a 180° reversal into the neck is impossible.
 */
import { useCallback, useEffect, useRef, useState, type TouchEvent } from "react";
import { randInt } from "../lib/rng";
import {
  renderApp,
  tellModel,
  updateContext,
  useFlash,
  useFullscreen,
  type AppProps,
} from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./snake.module.css";

const GRID = 17;

type Cell = { x: number; y: number };
type Speed = "slow" | "normal" | "fast";
type Borders = "hard" | "soft";
type Status = "ready" | "playing" | "paused" | "over";

const DIR = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
} as const;

const SPEED_MS: Record<Speed, number> = { slow: 200, normal: 130, fast: 85 };

const isOpposite = (a: Cell, b: Cell) => a.x === -b.x && a.y === -b.y;

interface Game {
  snake: Cell[]; // head first
  dir: Cell; // committed direction of travel
  food: Cell;
  score: number;
  status: Status;
}

/** Deterministic fresh game (avoids random during React init → StrictMode-safe). */
function newGame(status: Status = "ready"): Game {
  const cy = Math.floor(GRID / 2);
  const hx = Math.floor(GRID / 2);
  const snake: Cell[] = [
    { x: hx, y: cy },
    { x: hx - 1, y: cy },
    { x: hx - 2, y: cy },
  ];
  return { snake, dir: { ...DIR.right }, food: { x: GRID - 4, y: cy }, score: 0, status };
}

/** Random empty cell for new food; `null` if the board is full (a win). */
function placeFood(snake: Cell[]): Cell | null {
  const taken = new Set(snake.map((c) => c.y * GRID + c.x));
  const free: number[] = [];
  for (let i = 0; i < GRID * GRID; i++) if (!taken.has(i)) free.push(i);
  if (free.length === 0) return null;
  const idx = free[randInt(0, free.length - 1)];
  return { x: idx % GRID, y: Math.floor(idx / GRID) };
}

/** Advance one tick. `dir` is pre-validated as non-reversing by the caller. */
function step(g: Game, dir: Cell, borders: Borders): Game {
  const head = g.snake[0];
  let nx = head.x + dir.x;
  let ny = head.y + dir.y;

  if (borders === "soft") {
    nx = (nx + GRID) % GRID;
    ny = (ny + GRID) % GRID;
  } else if (nx < 0 || nx >= GRID || ny < 0 || ny >= GRID) {
    return { ...g, dir, status: "over" };
  }

  const eating = nx === g.food.x && ny === g.food.y;
  // Without eating, the tail vacates this tick, so it's safe to move onto it.
  const body = eating ? g.snake : g.snake.slice(0, -1);
  if (body.some((c) => c.x === nx && c.y === ny)) {
    return { ...g, dir, status: "over" };
  }

  const newSnake: Cell[] = [{ x: nx, y: ny }, ...g.snake];
  if (!eating) {
    newSnake.pop();
    return { ...g, snake: newSnake, dir };
  }

  const food = placeFood(newSnake);
  const score = g.score + 1;
  if (!food) return { ...g, snake: newSnake, dir, score, status: "over" }; // board full
  return { snake: newSnake, dir, food, score, status: "playing" };
}

const ROT: Record<"up" | "down" | "left" | "right", number> = { up: 0, right: 90, down: 180, left: 270 };
function Arrow({ dir }: { dir: keyof typeof ROT }) {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path d="M12 5 L19 17 H5 Z" transform={`rotate(${ROT[dir]} 12 12)`} fill="currentColor" />
    </svg>
  );
}

function SnakeApp({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [status, flash] = useFlash();

  const [game, setGame] = useState<Game>(() => newGame("ready"));
  const gameRef = useRef(game); // live authoritative state read by the tick
  const dirRef = useRef(game.dir); // committed direction (for reversal checks)
  const nextDirRef = useRef(game.dir); // queued direction for the next tick

  const [speed, setSpeed] = useState<Speed>("normal");
  const [borders, setBorders] = useState<Borders>("hard");
  const bordersRef = useRef<Borders>(borders);
  const [best, setBest] = useState(0);
  const reportedOver = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // Optional initial speed from the tool input (may arrive after mount).
  useEffect(() => {
    const sp = runtime.toolInput?.speed;
    if (sp === "slow" || sp === "normal" || sp === "fast") setSpeed(sp);
  }, [runtime.toolInput]);

  useEffect(() => { bordersRef.current = borders; }, [borders]);

  // Single funnel for every state change → keeps refs and React state in lockstep.
  const commit = useCallback((next: Game) => {
    gameRef.current = next;
    dirRef.current = next.dir;
    setGame(next);
  }, []);

  // Game loop: one interval while playing; its period tracks the chosen speed.
  useEffect(() => {
    if (game.status !== "playing") return;
    const id = window.setInterval(() => {
      const g = gameRef.current;
      if (g.status !== "playing") return;
      commit(step(g, nextDirRef.current, bordersRef.current));
    }, SPEED_MS[speed]);
    return () => window.clearInterval(id);
  }, [game.status, speed, commit]);

  useEffect(() => { setBest((b) => (game.score > b ? game.score : b)); }, [game.score]);

  // Silently keep the model aware of the final score (no forced model turn).
  useEffect(() => {
    if (game.status === "over" && !reportedOver.current) {
      reportedOver.current = true;
      void updateContext(
        runtime,
        `Snake game over — final score ${game.score} (food eaten) on a ${GRID}×${GRID} board with ${borders === "soft" ? "wrap-around" : "solid"} walls.`,
      );
    }
    if (game.status !== "over") reportedOver.current = false;
  }, [game.status, game.score, borders, runtime]);

  const turn = useCallback((d: Cell) => {
    const g = gameRef.current;
    if (g.status === "over") return;
    if (g.status === "ready") {
      nextDirRef.current = isOpposite(d, dirRef.current) ? dirRef.current : d;
      commit({ ...g, status: "playing" });
      return;
    }
    if (g.status !== "playing") return;
    if (isOpposite(d, dirRef.current)) return; // never reverse into the neck
    nextDirRef.current = d;
  }, [commit]);

  const togglePause = useCallback(() => {
    const g = gameRef.current;
    if (g.status === "playing") commit({ ...g, status: "paused" });
    else if (g.status === "paused" || g.status === "ready") commit({ ...g, status: "playing" });
  }, [commit]);

  const startFresh = useCallback((play: boolean) => {
    const g = newGame(play ? "playing" : "ready");
    nextDirRef.current = g.dir;
    reportedOver.current = false;
    commit(g);
  }, [commit]);

  const tell = useCallback(async () => {
    const ok = await tellModel(runtime, `I scored ${game.score} in Snake! 🐍`, `Snake result: score ${game.score}.`);
    flash(runtime.standalone ? "Preview (not sent)" : ok ? "Sent to chat" : "Couldn't send");
  }, [runtime, game.score, flash]);

  // Physical keyboard: arrows + WASD to steer, Space to pause/resume.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "arrowup" || k === "w") { e.preventDefault(); turn(DIR.up); }
      else if (k === "arrowdown" || k === "s") { e.preventDefault(); turn(DIR.down); }
      else if (k === "arrowleft" || k === "a") { e.preventDefault(); turn(DIR.left); }
      else if (k === "arrowright" || k === "d") { e.preventDefault(); turn(DIR.right); }
      else if (k === " " || k === "spacebar") {
        // Let a focused control handle its own Space activation instead.
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT") return;
        e.preventDefault();
        togglePause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [turn, togglePause]);

  // Touch swipe on the board → direction. `touch-action: none` blocks scrolling.
  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchMove = (e: TouchEvent) => {
    if (!touchStart.current) return;
    const t = e.touches[0];
    const dx = t.clientX - touchStart.current.x;
    const dy = t.clientY - touchStart.current.y;
    const TH = 22;
    if (Math.abs(dx) < TH && Math.abs(dy) < TH) return;
    if (Math.abs(dx) > Math.abs(dy)) turn(dx > 0 ? DIR.right : DIR.left);
    else turn(dy > 0 ? DIR.down : DIR.up);
    touchStart.current = { x: t.clientX, y: t.clientY }; // allow chained swipes
  };
  const onTouchEnd = () => { touchStart.current = null; };

  // ---- Head geometry (eyes point the way it's travelling) -----------------
  const head = game.snake[0];
  const hc = { x: head.x + 0.5, y: head.y + 0.5 };
  const d = game.dir;
  const perp = { x: d.y, y: -d.x };
  const eyeF = 0.14, eyeS = 0.17, eyeR = 0.1, pupR = 0.05, pupF = 0.05;
  const eyeA = { x: hc.x + d.x * eyeF + perp.x * eyeS, y: hc.y + d.y * eyeF + perp.y * eyeS };
  const eyeB = { x: hc.x + d.x * eyeF - perp.x * eyeS, y: hc.y + d.y * eyeF - perp.y * eyeS };

  const insets = runtime.hostContext?.safeAreaInsets;

  return (
    <div
      ref={rootRef}
      className={`${s.root} ${isFull ? s.full : ""}`}
      style={{
        paddingTop: insets?.top,
        paddingRight: insets?.right,
        paddingBottom: insets?.bottom,
        paddingLeft: insets?.left,
      }}
    >
      <header className={s.header}>
        <h1 className={ui.title}>🐍 Snake</h1>
        <p className={ui.subtitle}>Score <b>{game.score}</b> · Best <b>{best}</b></p>
      </header>

      <div className={s.boardWrap}>
        <svg
          className={s.board}
          viewBox={`0 0 ${GRID} ${GRID}`}
          width="100%"
          height="100%"
          role="img"
          aria-label={`Snake board — score ${game.score}`}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <defs>
            <pattern id="snakeGrid" width="1" height="1" patternUnits="userSpaceOnUse">
              <path className={s.grid} d="M1 0V1M0 1H1" />
            </pattern>
          </defs>

          <rect className={s.cellBg} x="0" y="0" width={GRID} height={GRID} />
          <rect x="0" y="0" width={GRID} height={GRID} fill="url(#snakeGrid)" />

          {/* Food — a small apple. */}
          <g>
            <circle cx={game.food.x + 0.5} cy={game.food.y + 0.56} r={0.33} fill="#f59e0b" />
            <rect x={game.food.x + 0.47} y={game.food.y + 0.16} width={0.06} height={0.2} rx={0.03} fill="#7c2d12" />
            <ellipse
              cx={game.food.x + 0.63}
              cy={game.food.y + 0.24}
              rx={0.13}
              ry={0.07}
              fill="#22c55e"
              transform={`rotate(-35 ${game.food.x + 0.63} ${game.food.y + 0.24})`}
            />
          </g>

          {/* Snake — body first, head (brighter, with eyes) on top. */}
          {game.snake.slice(1).map((c, i) => (
            <rect key={i} className={s.body} x={c.x + 0.08} y={c.y + 0.08} width={0.84} height={0.84} rx={0.22} ry={0.22} />
          ))}
          <rect className={s.head} x={head.x + 0.04} y={head.y + 0.04} width={0.92} height={0.92} rx={0.26} ry={0.26} />
          <circle cx={eyeA.x} cy={eyeA.y} r={eyeR} fill="#ffffff" />
          <circle cx={eyeB.x} cy={eyeB.y} r={eyeR} fill="#ffffff" />
          <circle cx={eyeA.x + d.x * pupF} cy={eyeA.y + d.y * pupF} r={pupR} fill="#1f2937" />
          <circle cx={eyeB.x + d.x * pupF} cy={eyeB.y + d.y * pupF} r={pupR} fill="#1f2937" />

          <rect className={s.frame} x="0.03" y="0.03" width={GRID - 0.06} height={GRID - 0.06} rx={0.2} />
        </svg>

        {game.status !== "playing" && (
          <div className={s.overlay}>
            {game.status === "over" ? (
              <>
                <span className={`${ui.banner} ${ui.lose}`}>Game over</span>
                <p className={s.big}>Score {game.score}</p>
                <button className={`${ui.btn} ${ui.primary}`} onClick={() => startFresh(true)}>Play again</button>
              </>
            ) : game.status === "paused" ? (
              <>
                <p className={s.big}>Paused</p>
                <button className={`${ui.btn} ${ui.primary}`} onClick={togglePause}>Resume</button>
              </>
            ) : (
              <>
                <p className={s.big}>🐍 Snake</p>
                <p className={ui.subtitle}>Arrows / WASD · swipe · D-pad</p>
                <button className={`${ui.btn} ${ui.primary}`} onClick={() => startFresh(true)}>Play</button>
              </>
            )}
          </div>
        )}
      </div>

      {/* On-screen D-pad (SVG arrows) — great for touch, harmless on desktop. */}
      <div className={s.dpad} role="group" aria-label="Direction pad">
        <button className={`${s.dbtn} ${s.up}`} aria-label="Up" onClick={() => turn(DIR.up)}><Arrow dir="up" /></button>
        <button className={`${s.dbtn} ${s.left}`} aria-label="Left" onClick={() => turn(DIR.left)}><Arrow dir="left" /></button>
        <button className={`${s.dbtn} ${s.right}`} aria-label="Right" onClick={() => turn(DIR.right)}><Arrow dir="right" /></button>
        <button className={`${s.dbtn} ${s.down}`} aria-label="Down" onClick={() => turn(DIR.down)}><Arrow dir="down" /></button>
      </div>

      <div className={ui.controls}>
        <button className={`${ui.btn} ${ui.primary}`} onClick={togglePause} disabled={game.status === "over"}>
          {game.status === "playing" ? "Pause" : game.status === "paused" ? "Resume" : "Play"}
        </button>
        <button className={ui.btn} onClick={() => startFresh(false)}>Restart</button>
        <button className={ui.btn} onClick={toggleFull}>{isFull ? "Exit fullscreen" : "Fullscreen"}</button>
        <button className={ui.btn} onClick={tell} disabled={game.status !== "over"}>Tell the model</button>
      </div>

      <div className={ui.controls}>
        <div className={s.seg} role="group" aria-label="Speed">
          {(["slow", "normal", "fast"] as Speed[]).map((sp) => (
            <button
              key={sp}
              className={`${s.segBtn} ${speed === sp ? s.segOn : ""}`}
              aria-pressed={speed === sp}
              onClick={() => setSpeed(sp)}
            >
              {sp[0].toUpperCase() + sp.slice(1)}
            </button>
          ))}
        </div>
        <div className={s.seg} role="group" aria-label="Walls">
          <button className={`${s.segBtn} ${borders === "hard" ? s.segOn : ""}`} aria-pressed={borders === "hard"} onClick={() => setBorders("hard")}>Walls</button>
          <button className={`${s.segBtn} ${borders === "soft" ? s.segOn : ""}`} aria-pressed={borders === "soft"} onClick={() => setBorders("soft")}>Wrap</button>
        </div>
      </div>

      <p className={ui.status} role="status" aria-live="polite">{status}</p>
    </div>
  );
}

renderApp({ name: "Snake App", version: "1.0.0" }, SnakeApp);
