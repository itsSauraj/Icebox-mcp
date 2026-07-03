/**
 * @file Classic grid Snake with buttery motion.
 *
 * Motion is decoupled from React: a fixed-timestep `requestAnimationFrame` loop
 * (accumulator) advances the logic ~8fps, while each snake segment is an
 * absolutely-positioned HTML `<div>` that CSS-transitions its `transform` from
 * its old cell to its new one — so the browser compositor interpolates the
 * crawl at 60fps and we only re-render on a logical step. `setInterval` is
 * avoided on purpose (it gets throttled/jittery inside a host iframe).
 *
 * The live game lives in `gameRef` so the loop reads fresh state without stale
 * closures. Direction input is buffered in a small queue (max 2) and validated
 * so a 180° reversal into the neck is impossible. Fully self-contained.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type TouchEvent,
} from "react";
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
import { SnakeIcon } from "../lib/icons";
import s from "./snake.module.css";

const GRID = 25;

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

const SPEED_MS: Record<Speed, number> = { slow: 190, normal: 125, fast: 80 };

const isOpposite = (a: Cell, b: Cell) => a.x === -b.x && a.y === -b.y;
const eq = (a: Cell, b: Cell) => a.x === b.x && a.y === b.y;

/** Custom-property styles (CSS vars) → typed as CSSProperties. */
const sv = (o: Record<string, string | number>): CSSProperties => o as unknown as CSSProperties;

interface Game {
  snake: Cell[]; // head first
  dir: Cell; // committed direction of travel
  food: Cell;
  score: number;
  status: Status;
}

/** Deterministic fresh game (no random during init → StrictMode-safe). */
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
  const gameRef = useRef(game); // live authoritative state read by the loop
  const dirRef = useRef(game.dir); // committed direction
  const dirQueueRef = useRef<Cell[]>([]); // buffered turns (max 2)
  const prevSnakeRef = useRef<Cell[]>(game.snake); // last render's cells (for wrap detection)

  const [speed, setSpeed] = useState<Speed>("normal");
  const [borders, setBorders] = useState<Borders>("hard");
  const bordersRef = useRef<Borders>(borders);
  const [best, setBest] = useState(0);
  const reportedOver = useRef(false);
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // rAF loop bookkeeping.
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef(0);
  const accRef = useRef(0);

  // Optional initial speed from the tool input (may arrive after mount).
  useEffect(() => {
    const sp = runtime.toolInput?.speed;
    if (sp === "slow" || sp === "normal" || sp === "fast") setSpeed(sp);
  }, [runtime.toolInput]);

  useEffect(() => { bordersRef.current = borders; }, [borders]);
  useEffect(() => { prevSnakeRef.current = game.snake; }, [game.snake]);

  // Single funnel for every state change → keeps refs and React state in lockstep.
  const commit = useCallback((next: Game) => {
    gameRef.current = next;
    dirRef.current = next.dir;
    setGame(next);
  }, []);

  // Fixed-timestep game loop on requestAnimationFrame. Steady inside the iframe,
  // catches up cleanly after a stall, and never renders on idle frames.
  useEffect(() => {
    if (game.status !== "playing") return;
    const tickMs = SPEED_MS[speed];
    lastTimeRef.current = performance.now();
    accRef.current = 0;

    const loop = (now: number) => {
      const g0 = gameRef.current;
      if (g0.status !== "playing") return;
      let dt = now - lastTimeRef.current;
      lastTimeRef.current = now;
      if (dt > 250) dt = 250; // drop huge gaps (backgrounded tab)
      accRef.current += dt;

      let cur = g0;
      let stepped = false;
      while (accRef.current >= tickMs && cur.status === "playing") {
        accRef.current -= tickMs;
        const q = dirQueueRef.current;
        if (q.length) dirRef.current = q.shift()!; // apply one buffered turn
        cur = step(cur, dirRef.current, bordersRef.current);
        stepped = true;
      }
      if (stepped) commit(cur);
      if (cur.status === "playing") rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
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

  // Buffer a turn. Validate against the LAST queued dir (or committed dir if the
  // queue is empty) so quick sequential turns register but a reversal can't.
  const enqueueTurn = useCallback((dir: Cell) => {
    const g = gameRef.current;
    if (g.status === "over") return;
    if (g.status === "ready") {
      dirQueueRef.current = [];
      if (!isOpposite(dir, dirRef.current) && !eq(dir, dirRef.current)) dirQueueRef.current.push(dir);
      commit({ ...g, status: "playing" });
      return;
    }
    if (g.status !== "playing") return;
    const q = dirQueueRef.current;
    if (q.length >= 2) return;
    const last = q.length ? q[q.length - 1] : dirRef.current;
    if (isOpposite(dir, last) || eq(dir, last)) return;
    q.push(dir);
  }, [commit]);

  const togglePause = useCallback(() => {
    const g = gameRef.current;
    if (g.status === "playing") commit({ ...g, status: "paused" });
    else if (g.status === "paused" || g.status === "ready") commit({ ...g, status: "playing" });
  }, [commit]);

  const startFresh = useCallback((play: boolean) => {
    dirQueueRef.current = [];
    reportedOver.current = false;
    commit(newGame(play ? "playing" : "ready"));
  }, [commit]);

  const tell = useCallback(async () => {
    const ok = await tellModel(runtime, `I scored ${game.score} in Snake!`, `Snake result: score ${game.score}.`);
    flash(runtime.standalone ? "Preview (not sent)" : ok ? "Sent to chat" : "Couldn't send");
  }, [runtime, game.score, flash]);

  // Physical keyboard: arrows + WASD to steer, Space to pause/resume.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "arrowup" || k === "w") { e.preventDefault(); enqueueTurn(DIR.up); }
      else if (k === "arrowdown" || k === "s") { e.preventDefault(); enqueueTurn(DIR.down); }
      else if (k === "arrowleft" || k === "a") { e.preventDefault(); enqueueTurn(DIR.left); }
      else if (k === "arrowright" || k === "d") { e.preventDefault(); enqueueTurn(DIR.right); }
      else if (k === " " || k === "spacebar") {
        const tag = (e.target as HTMLElement | null)?.tagName;
        if (tag === "BUTTON" || tag === "INPUT" || tag === "SELECT") return;
        e.preventDefault();
        togglePause();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enqueueTurn, togglePause]);

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
    const TH = 20;
    if (Math.abs(dx) < TH && Math.abs(dy) < TH) return;
    if (Math.abs(dx) > Math.abs(dy)) enqueueTurn(dx > 0 ? DIR.right : DIR.left);
    else enqueueTurn(dy > 0 ? DIR.down : DIR.up);
    touchStart.current = { x: t.clientX, y: t.clientY }; // allow chained swipes
  };
  const onTouchEnd = () => { touchStart.current = null; };

  const d = game.dir;
  const dirName = d.x === 1 ? "right" : d.x === -1 ? "left" : d.y === 1 ? "down" : "up";
  const prev = prevSnakeRef.current;
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
        <h1 className={ui.title}><SnakeIcon className={ui.titleIcon} />Snake</h1>
        <p className={ui.subtitle}>Score <b>{game.score}</b> · Best <b>{best}</b></p>
      </header>

      <div className={s.boardWrap}>
        <div
          className={s.board}
          style={sv({ "--grid": GRID, "--tick": `${SPEED_MS[speed]}ms` })}
          role="img"
          aria-label={`Snake board — score ${game.score}`}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          {/* Food — a pulsing amber apple. Keyed by cell so each spawn re-pops. */}
          <div key={`f${game.food.x}-${game.food.y}`} className={s.food} style={sv({ "--x": game.food.x, "--y": game.food.y })}>
            <svg viewBox="0 0 24 24" className={s.apple} aria-hidden="true">
              <circle cx="12" cy="14" r="8" fill="#f59e0b" />
              <rect x="11.1" y="4" width="1.8" height="6" rx="0.9" fill="#7c2d12" />
              <ellipse cx="16.5" cy="7" rx="3.6" ry="1.9" fill="#22c55e" transform="rotate(-35 16.5 7)" />
              <circle cx="9.3" cy="12" r="1.7" fill="#ffffff" opacity="0.45" />
            </svg>
          </div>

          {/* Snake — each segment glides one cell via CSS transition (keyed by
              index → follow-the-leader crawl). Wrap jumps skip the transition. */}
          {game.snake.map((c, i) => {
            const p = prev[i];
            const jumped = p ? Math.abs(c.x - p.x) > 1 || Math.abs(c.y - p.y) > 1 : false;
            const style = sv(jumped ? { "--x": c.x, "--y": c.y, transition: "none" } : { "--x": c.x, "--y": c.y });
            if (i === 0) {
              return (
                <div key={i} className={`${s.snakeSeg} ${s.snakeHead}`} style={style}>
                  <svg viewBox="0 0 24 24" className={s.eyes} style={{ transform: `rotate(${ROT[dirName]}deg)` }} aria-hidden="true">
                    <circle cx="8" cy="7.5" r="2.6" fill="#ffffff" />
                    <circle cx="16" cy="7.5" r="2.6" fill="#ffffff" />
                    <circle cx="8" cy="8.3" r="1.2" fill="#1f2937" />
                    <circle cx="16" cy="8.3" r="1.2" fill="#1f2937" />
                  </svg>
                </div>
              );
            }
            return <div key={i} className={s.snakeSeg} style={style} />;
          })}
        </div>

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
                <p className={s.big}><SnakeIcon className={ui.titleIcon} />Snake</p>
                <p className={ui.subtitle}>Arrows / WASD · swipe · D-pad</p>
                <button className={`${ui.btn} ${ui.primary}`} onClick={() => startFresh(true)}>Play</button>
              </>
            )}
          </div>
        )}
      </div>

      {/* On-screen D-pad (SVG arrows) — great for touch, harmless on desktop. */}
      <div className={s.dpad} role="group" aria-label="Direction pad">
        <button className={`${s.dbtn} ${s.up}`} aria-label="Up" onClick={() => enqueueTurn(DIR.up)}><Arrow dir="up" /></button>
        <button className={`${s.dbtn} ${s.left}`} aria-label="Left" onClick={() => enqueueTurn(DIR.left)}><Arrow dir="left" /></button>
        <button className={`${s.dbtn} ${s.right}`} aria-label="Right" onClick={() => enqueueTurn(DIR.right)}><Arrow dir="right" /></button>
        <button className={`${s.dbtn} ${s.down}`} aria-label="Down" onClick={() => enqueueTurn(DIR.down)}><Arrow dir="down" /></button>
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
