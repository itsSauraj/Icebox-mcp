/**
 * @file Tetris to the guideline: SRS rotation with wall kicks, a 7-bag
 * randomizer, a hold slot, a three-deep preview and a ghost piece.
 *
 * **Rotation is generated, not tabulated.** A piece is four cells in a bounding
 * box (3x3, 4x4 for I, 2x2 for O) and a rotation is that box turned
 * `(x, y) -> (n-1-y, x)`, so four states per piece are built once at load. Only
 * the kicks are data: the canonical SRS five-test lists, stored already flipped
 * into screen coordinates so nothing has to negate a sign at runtime. They are
 * what makes a T-spin possible, so the piece carries `spun` and the
 * three-corner rule is checked at lock time.
 *
 * **The board lives in a ref.** Gravity runs in `useGameLoop` while input
 * arrives from keyboard, touch and buttons, so every change funnels through
 * `commit`, which writes the ref and the React state together. The loop reads
 * the ref, never a closure.
 *
 * **Timers are refs.** Lock delay, the clear flash and the announcement tick
 * down without re-rendering. The loop period is `min(gravity, 50ms)`: derived
 * from the level, but never so coarse that a 500ms lock delay rounds up to a
 * whole gravity step at level one.
 *
 * The opening board and the first bag are empty, because StrictMode invokes
 * state initialisers twice and two different first bags is exactly the bug that
 * causes. The first shuffle happens when the player presses Play.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import {
  DPad,
  GameFrame,
  GameHeader,
  Overlay,
  StandardControls,
  StatusLine,
  isTerminal,
  seedNumber,
  sv,
  useBest,
  useDirectionKeys,
  useFullscreen,
  useGameLoop,
  useGameOverReport,
  useKeys,
  useSeed,
  useShare,
  useSwipe,
  type Direction,
  type GameStatus,
} from "../lib/game";
import { shuffle } from "../lib/rng";
import type { AppProps } from "../lib/runtime";
import s from "./tetris.module.css";

const W = 10;
const H = 20;
const NEXT = 3;
const MAX_LEVEL = 15;

/** Loop resolution: fine enough for a 500ms lock delay at any gravity. */
const TICK_MS = 50;
const LOCK_MS = 500;
/** Move resets bought on one landing, after which stalling has to end. */
const LOCK_RESET_CAP = 15;
const CLEAR_MS = 220;
const TOAST_MS = 1000;

type Kind = "I" | "O" | "T" | "S" | "Z" | "J" | "L";
type XY = readonly [number, number];

const KINDS: readonly Kind[] = ["I", "O", "T", "S", "Z", "J", "L"];

/**
 * The canonical seven, and the one place a literal colour belongs: on a Tetris
 * board the colour *is* the piece, and anyone who knows the game reads the well
 * by hue before shape. Every cell gets a dark ring and a lit top edge in CSS,
 * which is what keeps cyan and yellow legible on a light host and blue and
 * purple legible on a dark one.
 */
const COLOURS: Record<Kind, string> = {
  I: "#31c7ef",
  O: "#f7d308",
  T: "#ad4d9c",
  S: "#42b642",
  Z: "#ef2029",
  J: "#3155c7",
  L: "#ef7921",
};

/** Spawn state: cells inside a box of `box` squares, y growing downwards. */
const SHAPES: Record<Kind, { box: number; cells: XY[] }> = {
  I: { box: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]] },
  O: { box: 2, cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
  T: { box: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]] },
  S: { box: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  Z: { box: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  J: { box: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  L: { box: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]] },
};

/** Where the box lands, so every piece spawns over the middle four columns. */
const SPAWN_X: Record<Kind, number> = { I: 3, O: 4, T: 3, S: 3, Z: 3, J: 3, L: 3 };

/** All four rotations of all seven pieces, turned once at module load. */
const ROTATIONS: Record<Kind, XY[][]> = (() => {
  const out = {} as Record<Kind, XY[][]>;
  for (const k of KINDS) {
    const { box, cells } = SHAPES[k];
    const states: XY[][] = [cells];
    for (let r = 1; r < 4; r++) states.push(states[r - 1].map(([x, y]) => [box - 1 - y, x] as XY));
    out[k] = states;
  }
  return out;
})();

/** Spawn shape centred in a four-by-two preview box; offsets may be fractional. */
const PREVIEW: Record<Kind, XY[]> = (() => {
  const out = {} as Record<Kind, XY[]>;
  for (const k of KINDS) {
    const xs = ROTATIONS[k][0].map(([x]) => x);
    const ys = ROTATIONS[k][0].map(([, y]) => y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const ox = (4 - (Math.max(...xs) - minX + 1)) / 2 - minX;
    const oy = (2 - (Math.max(...ys) - minY + 1)) / 2 - minY;
    out[k] = ROTATIONS[k][0].map(([x, y]) => [x + ox, y + oy] as XY);
  }
  return out;
})();

/**
 * SRS wall kicks, keyed `from`+`to` and already flipped into screen
 * coordinates. Five tests in order, first fit wins: that is what lets a piece
 * climb a wall or screw into a T-slot. The I piece kicks two columns, so it has
 * its own table.
 */
const KICKS_JLSTZ: Record<string, XY[]> = {
  "01": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "10": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "12": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  "21": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  "23": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  "32": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "30": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  "03": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
};
const KICKS_I: Record<string, XY[]> = {
  "01": [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  "10": [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  "12": [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
  "21": [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  "23": [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
  "32": [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
  "30": [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
  "03": [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
};

/**
 * Guideline gravity: the classic frames-per-row table at 60fps, in milliseconds
 * per row. A second at level one down to a single frame at fifteen, where the
 * curve flattens into instant drop.
 */
const GRAVITY_MS = [1000, 793, 618, 473, 355, 262, 190, 135, 94, 64, 43, 28, 18, 11, 7];
const gravityMs = (level: number) => GRAVITY_MS[Math.min(level, GRAVITY_MS.length) - 1];

const LINE_SCORE = [0, 100, 300, 500, 800];
const CLEAR_NAME = ["", "Single", "Double", "Triple", "Tetris"];
/** Off the base table: a T-spin that clears nothing still has to pay something. */
const T_SPIN_BONUS = 400;

/** Key legend for the ready screen, as [keys, what it does]. */
const KEY_HELP: readonly (readonly [string, string])[] = [
  ["← →", "move"],
  ["↑ / X", "rotate"],
  ["Z", "counter"],
  ["↓", "soft drop"],
  ["Space", "hard drop"],
  ["C", "hold"],
  ["P", "pause"],
];

interface Piece {
  kind: Kind;
  /** 0 spawn, 1 clockwise, 2 flipped, 3 anticlockwise. */
  rot: number;
  /** Top-left of the bounding box, in board cells. */
  x: number;
  y: number;
  /** Last successful action was a rotation: a prerequisite for a T-spin. */
  spun: boolean;
}

interface Game {
  /** Row-major, `kind index + 1` per filled cell, 0 for empty. */
  board: number[];
  piece: Piece | null;
  hold: Kind | null;
  holdUsed: boolean;
  /** What is left of the current bag of seven. */
  bag: Kind[];
  queue: Kind[];
  score: number;
  lines: number;
  level: number;
  startLevel: number;
  /** Last clear was a tetris, so the next one doubles. */
  b2b: boolean;
  status: GameStatus;
  /** Rows mid-flash. Gravity is suspended while this is set. */
  clearing: number[] | null;
  /** Cells the last lock filled, so only those pop. */
  locked: number[];
  /** Collapses so far. Rekeys the stack so it settles into its new place. */
  settle: number;
  /** Locks so far. Keys the announcement so it replays. */
  beat: number;
  toast: string | null;
}

/** Fresh game. No randomness: StrictMode runs initialisers twice. */
function newGame(startLevel: number): Game {
  return {
    board: new Array<number>(W * H).fill(0),
    piece: null, hold: null, holdUsed: false, bag: [], queue: [],
    score: 0, lines: 0, level: startLevel, startLevel, b2b: false,
    status: "ready", clearing: null, locked: [], settle: 0, beat: 0, toast: null,
  };
}

/** Off the sides, through the floor, or onto a filled cell. Above the top is fine. */
function collides(board: number[], p: Piece): boolean {
  for (const [dx, dy] of ROTATIONS[p.kind][p.rot]) {
    const x = p.x + dx;
    const y = p.y + dy;
    if (x < 0 || x >= W || y >= H) return true;
    if (y >= 0 && board[y * W + x]) return true;
  }
  return false;
}

const newPiece = (kind: Kind): Piece => ({ kind, rot: 0, x: SPAWN_X[kind], y: 0, spun: false });

function dropDist(board: number[], p: Piece): number {
  let d = 0;
  while (!collides(board, { ...p, y: p.y + d + 1 })) d++;
  return d;
}

/** Rotate with kicks, or null when all five tests fail. O never turns. */
function tryRotate(board: number[], p: Piece, dir: 1 | -1): Piece | null {
  if (p.kind === "O") return null;
  const to = (p.rot + dir + 4) % 4;
  for (const [dx, dy] of (p.kind === "I" ? KICKS_I : KICKS_JLSTZ)[`${p.rot}${to}`]) {
    const cand: Piece = { kind: p.kind, rot: to, x: p.x + dx, y: p.y + dy, spun: true };
    if (!collides(board, cand)) return cand;
  }
  return null;
}

/**
 * The three-corner rule. A T that finished on a rotation with three of the four
 * squares diagonal to its centre occupied has been screwed into a slot it could
 * never have been dropped into.
 */
function tSpinCorners(board: number[], p: Piece): number {
  let n = 0;
  for (const [dx, dy] of [[0, 0], [2, 0], [0, 2], [2, 2]] as XY[]) {
    const x = p.x + dx;
    const y = p.y + dy;
    if (x < 0 || x >= W || y >= H || (y >= 0 && board[y * W + x])) n++;
  }
  return n;
}

function fullRows(board: number[]): number[] {
  const rows: number[] = [];
  for (let y = 0; y < H; y++) {
    let full = true;
    for (let x = 0; x < W && full; x++) full = board[y * W + x] !== 0;
    if (full) rows.push(y);
  }
  return rows;
}

/**
 * Top the preview up out of the bag, refilling with a fresh shuffle of all
 * seven when it runs dry. Naive random deals four S pieces in a row and players
 * notice; a bag guarantees every piece inside any seven.
 */
function refill(bag: Kind[], queue: Kind[], want: number) {
  const b = bag.slice();
  const q = queue.slice();
  while (q.length < want) {
    if (b.length === 0) b.push(...shuffle(KINDS));
    q.push(b.shift() as Kind);
  }
  return { bag: b, queue: q };
}

/** Put a specific piece at the top. A collision here is the loss condition. */
function place(g: Game, kind: Kind): Game {
  const piece = newPiece(kind);
  if (collides(g.board, piece)) return { ...g, piece: null, status: "over" };
  return { ...g, piece };
}

/** Take the head of the preview and top the preview back up. */
function spawn(g: Game): Game {
  const head = refill(g.bag, g.queue, 1);
  const rest = refill(head.bag, head.queue.slice(1), NEXT);
  return place({ ...g, bag: rest.bag, queue: rest.queue }, head.queue[0]);
}

function clearLabel(n: number, tSpin: boolean, b2b: boolean): string {
  if (tSpin) return n ? `T-spin ${CLEAR_NAME[n]}` : "T-spin";
  if (n === 4) return b2b ? "Back-to-back tetris" : "Tetris";
  return CLEAR_NAME[n];
}

/**
 * Stamp the piece into the board and score it. Returns a piece-less game: with
 * rows to clear it also carries `clearing` and the caller waits out the flash,
 * otherwise the caller spawns straight away.
 */
function lock(g: Game): Game {
  const p = g.piece as Piece;
  const board = g.board.slice();
  const locked: number[] = [];
  const id = KINDS.indexOf(p.kind) + 1;
  for (const [dx, dy] of ROTATIONS[p.kind][p.rot]) {
    const y = p.y + dy;
    if (y < 0) continue; // locked out above the ceiling: that cell is simply gone
    const i = y * W + (p.x + dx);
    board[i] = id;
    locked.push(i);
  }

  const tSpin = p.kind === "T" && p.spun && tSpinCorners(g.board, p) >= 3;
  const rows = fullRows(board);
  const n = rows.length;
  const b2b = n === 4 && g.b2b;
  const gained = LINE_SCORE[n] * (b2b ? 2 : 1) + (tSpin ? T_SPIN_BONUS : 0);
  const lines = g.lines + n;

  return {
    ...g,
    board,
    piece: null,
    holdUsed: false, // one hold per drop: locking is what buys the next one
    locked,
    beat: g.beat + 1,
    score: g.score + gained * g.level,
    lines,
    level: Math.min(g.startLevel + Math.floor(lines / 10), MAX_LEVEL),
    b2b: n === 4 ? true : n > 0 ? false : g.b2b,
    clearing: n ? rows : null,
    toast: n || tSpin ? clearLabel(n, tSpin, b2b) : null,
  };
}

/** Drop the flashed rows out and let everything above fall into the gap. */
function collapse(g: Game): Game {
  const gone = new Set(g.clearing ?? []);
  const board = new Array<number>(W * H).fill(0);
  let to = H - 1;
  for (let y = H - 1; y >= 0; y--) {
    if (gone.has(y)) continue;
    for (let x = 0; x < W; x++) board[to * W + x] = g.board[y * W + x];
    to--;
  }
  return { ...g, board, clearing: null, locked: [], settle: g.settle + 1 };
}

/** The four cells of the live piece, or of its ghost at the landing row. */
function pieceCells(p: Piece, top: number, ghost: boolean) {
  return ROTATIONS[p.kind][p.rot].map(([dx, dy], i) => {
    const y = top + dy;
    if (y < 0) return null;
    return (
      <div
        key={`${ghost ? "g" : "p"}${i}`}
        className={ghost ? `${s.slot} ${s.ghost}` : s.slot}
        style={sv({ "--x": p.x + dx, "--y": y, "--c": COLOURS[p.kind] })}
      >
        <div className={ghost ? s.ghostFace : s.face} />
      </div>
    );
  });
}

function TetrisIcon() {
  return (
    <svg viewBox="0 0 24 24" className={s.icon} aria-hidden="true">
      <rect x="9" y="4" width="5" height="5" rx="1" fill="currentColor" />
      <rect x="15" y="4" width="5" height="5" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="3" y="10" width="5" height="5" rx="1" fill="currentColor" opacity="0.55" />
      <rect x="9" y="10" width="5" height="5" rx="1" fill="currentColor" />
    </svg>
  );
}

/** One preview box: the hold slot, or a place in the next queue. */
function Mini({
  kind,
  label,
  small,
  spent,
}: {
  kind: Kind | null;
  label: string;
  small?: boolean;
  spent?: boolean;
}) {
  return (
    <div
      className={`${s.railBox} ${small ? s.railBoxSm : ""} ${spent ? s.spent : ""}`}
      role="img"
      aria-label={label}
    >
      {kind && (
        <div className={s.mini}>
          {PREVIEW[kind].map(([x, y], i) => (
            <div key={i} className={s.miniCell} style={sv({ "--x": x, "--y": y, "--c": COLOURS[kind] })}>
              <div className={s.miniFace} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Tetris({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const seed = useSeed(runtime);
  const startLevel = seedNumber(seed, "level", 1, 1, 10);

  const [game, setGame] = useState<Game>(() => newGame(1));
  const gameRef = useRef(game); // authoritative: the loop and three input paths share it

  // Timers. Refs, because counting down is not a reason to re-render.
  const gravityAcc = useRef(0);
  const lockLeft = useRef(LOCK_MS);
  const lockResets = useRef(0);
  const clearLeft = useRef(0);
  const toastLeft = useRef(0);
  const tapFrom = useRef<{ x: number; y: number } | null>(null);

  const commit = useCallback((next: Game) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  /** Spawn the next piece and start its clocks fresh. */
  const fresh = useCallback((g: Game): Game => {
    gravityAcc.current = 0;
    lockLeft.current = LOCK_MS;
    lockResets.current = 0;
    return spawn(g);
  }, []);

  /** Lock, then either wait out the clear flash or bring the next piece in. */
  const settle = useCallback(
    (g: Game): Game => {
      const after = lock(g);
      if (after.toast) toastLeft.current = TOAST_MS;
      if (!after.clearing) return fresh(after);
      clearLeft.current = CLEAR_MS;
      return after;
    },
    [fresh],
  );

  /**
   * A move or a rotation buys more lock delay, but only `LOCK_RESET_CAP` times
   * on one landing. In the air it costs nothing, since the delay is not running.
   */
  const bumpLock = useCallback((board: number[], p: Piece) => {
    if (!collides(board, { ...p, y: p.y + 1 })) {
      lockLeft.current = LOCK_MS;
    } else if (lockResets.current < LOCK_RESET_CAP) {
      lockResets.current++;
      lockLeft.current = LOCK_MS;
    }
  }, []);

  const reset = useCallback(
    (level: number, play: boolean) => {
      gravityAcc.current = 0;
      clearLeft.current = 0;
      toastLeft.current = 0;
      const base = newGame(level);
      commit(play ? fresh({ ...base, status: "playing" }) : base);
    },
    [commit, fresh],
  );

  // The seed lands after mount, so a starting level replaces the default then.
  useEffect(() => {
    if (gameRef.current.startLevel !== startLevel) reset(startLevel, false);
  }, [startLevel, reset]);

  // Gravity is the point of the tick, but the lock delay and the clear flash
  // count down on it too, so cap the period well under 500ms.
  const tickMs = Math.min(gravityMs(game.level), TICK_MS);

  const tick = useCallback(() => {
    let g = gameRef.current;
    if (g.status !== "playing") return;

    if (g.toast) {
      toastLeft.current -= tickMs;
      if (toastLeft.current <= 0) g = { ...g, toast: null };
    }

    if (g.clearing) {
      clearLeft.current -= tickMs;
      if (clearLeft.current <= 0) commit(fresh(collapse(g)));
      else if (g !== gameRef.current) commit(g);
      return;
    }
    if (!g.piece) {
      commit(fresh(g));
      return;
    }

    let p = g.piece;
    const rate = gravityMs(g.level);
    gravityAcc.current += tickMs;
    while (gravityAcc.current >= rate) {
      gravityAcc.current -= rate;
      const down: Piece = { ...p, y: p.y + 1, spun: false };
      if (collides(g.board, down)) {
        gravityAcc.current = 0;
        break;
      }
      p = down;
      // A new row is a new landing, so the reset credits come back.
      lockLeft.current = LOCK_MS;
      lockResets.current = 0;
    }
    if (p !== g.piece) g = { ...g, piece: p };

    if (collides(g.board, { ...p, y: p.y + 1 })) {
      lockLeft.current -= tickMs;
      if (lockLeft.current <= 0) {
        commit(settle(g));
        return;
      }
    }
    if (g !== gameRef.current) commit(g);
  }, [tickMs, commit, fresh, settle]);

  useGameLoop(game.status === "playing", tickMs, tick);

  const shift = useCallback(
    (dx: number) => {
      const g = gameRef.current;
      if (g.status !== "playing" || !g.piece) return;
      const p: Piece = { ...g.piece, x: g.piece.x + dx, spun: false };
      if (collides(g.board, p)) return;
      bumpLock(g.board, p);
      commit({ ...g, piece: p });
    },
    [commit, bumpLock],
  );

  const spin = useCallback(
    (dir: 1 | -1) => {
      const g = gameRef.current;
      if (g.status !== "playing" || !g.piece) return;
      const p = tryRotate(g.board, g.piece, dir);
      if (!p) return;
      bumpLock(g.board, p);
      commit({ ...g, piece: p });
    },
    [commit, bumpLock],
  );

  const softDrop = useCallback(() => {
    const g = gameRef.current;
    if (g.status !== "playing" || !g.piece) return;
    const p: Piece = { ...g.piece, y: g.piece.y + 1, spun: false };
    if (collides(g.board, p)) return;
    gravityAcc.current = 0;
    lockLeft.current = LOCK_MS;
    lockResets.current = 0;
    commit({ ...g, piece: p, score: g.score + 1 });
  }, [commit]);

  const hardDrop = useCallback(() => {
    const g = gameRef.current;
    if (g.status !== "playing" || !g.piece) return;
    const d = dropDist(g.board, g.piece);
    // A zero-cell hard drop keeps `spun`, so a T-spin can be finished with it.
    const p: Piece = { ...g.piece, y: g.piece.y + d, spun: d > 0 ? false : g.piece.spun };
    commit(settle({ ...g, piece: p, score: g.score + d * 2 }));
  }, [commit, settle]);

  const holdPiece = useCallback(() => {
    const g = gameRef.current;
    if (g.status !== "playing" || !g.piece || g.holdUsed) return;
    const kind = g.piece.kind;
    gravityAcc.current = 0;
    lockLeft.current = LOCK_MS;
    lockResets.current = 0;
    const swapped = g.hold ? place(g, g.hold) : spawn(g);
    commit({ ...swapped, hold: kind, holdUsed: true });
  }, [commit]);

  const togglePause = useCallback(() => {
    const g = gameRef.current;
    if (g.status === "playing") commit({ ...g, status: "paused" });
    else if (g.status === "paused") commit({ ...g, status: "playing" });
    else if (g.status === "ready") reset(g.startLevel, true);
  }, [commit, reset]);

  const onDirection = useCallback(
    (dir: Direction) => {
      if (dir === "up") spin(1);
      else if (dir === "down") softDrop();
      else shift(dir === "left" ? -1 : 1);
    },
    [spin, softDrop, shift],
  );

  // Arrows and WASD. No pause handler, so Space stays free for the hard drop.
  useDirectionKeys(onDirection);
  useKeys({
    " ": hardDrop,
    x: () => spin(1),
    z: () => spin(-1),
    c: holdPiece,
    shift: holdPiece,
    p: togglePause,
    escape: togglePause,
  });
  const swipe = useSwipe(onDirection);

  // Tap the well to rotate. A drag past a few pixels is a swipe, not a tap, and
  // pointer events cover the mouse too, so a click rotates on desktop.
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    tapFrom.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const from = tapFrom.current;
    if (from && (Math.abs(e.clientX - from.x) > 8 || Math.abs(e.clientY - from.y) > 8)) {
      tapFrom.current = null;
    }
  };
  const onPointerUp = () => {
    if (tapFrom.current) spin(1);
    tapFrom.current = null;
  };

  const best = useBest(game.score);
  const summary = `Score ${game.score}, ${game.lines} lines, level ${game.level}`;

  useGameOverReport(runtime, isTerminal(game.status), () => `Tetris over. ${summary}.`);

  const [shareStatus, share] = useShare(runtime);
  const tell = useCallback(() => {
    void share(
      `I scored ${game.score} in Tetris, ${game.lines} lines at level ${game.level}!`,
      `Tetris result: score ${game.score}, ${game.lines} lines, level ${game.level}.`,
    );
  }, [share, game.score, game.lines, game.level]);

  const flashing = game.clearing ? new Set(game.clearing) : null;
  const justLocked = new Set(game.locked);
  const piece = game.piece;
  const ghostY = piece ? piece.y + dropDist(game.board, piece) : 0;
  const ready = game.status === "ready";

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={isFull ? s.fullSize : ""}>
      <GameHeader
        title="Tetris"
        icon={<TetrisIcon />}
        stats={[
          { label: "Score", value: game.score },
          { label: "Lines", value: game.lines },
          { label: "Level", value: game.level },
          { label: "Best", value: best },
        ]}
        hint="Arrows move, up rotates, space drops"
      />

      <div className={s.playfield}>
        <div className={s.wellWrap}>
          <div
            className={s.well}
            role="img"
            aria-label={`Tetris well, 10 by 20. ${summary}.`}
            {...swipe}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
          >
            {/* The settled stack. A node mounts only when its cell was empty
                before (a lock) or when a collapse rekeyed the board, which is
                what makes the pop and the settle each play exactly once. */}
            {game.board.map((v, i) => {
              if (!v) return null;
              const y = Math.floor(i / W);
              const face = flashing?.has(y) ? s.flash : justLocked.has(i) ? s.pop : s.drop;
              return (
                <div
                  key={`${i}-${game.settle}`}
                  className={s.slot}
                  style={sv({ "--x": i % W, "--y": y, "--c": COLOURS[KINDS[v - 1]] })}
                >
                  <div className={`${s.face} ${face}`} />
                </div>
              );
            })}

            {/* Ghost: where a hard drop would land. */}
            {piece && ghostY > piece.y && pieceCells(piece, ghostY, true)}
            {piece && pieceCells(piece, piece.y, false)}
          </div>

          {game.toast && (
            <p key={game.beat} className={s.toast}>
              {game.toast}
            </p>
          )}

          <Overlay
            status={game.status}
            title={ready ? "Tetris" : undefined}
            detail={
              isTerminal(game.status)
                ? summary
                : ready
                  ? `Clear lines to climb the levels. Starting at level ${startLevel}.`
                  : undefined
            }
            action={ready ? "Play" : game.status === "paused" ? "Resume" : "Play again"}
            onAction={game.status === "paused" ? togglePause : () => reset(startLevel, true)}
          >
            {ready && (
              <p className={s.legend}>
                {KEY_HELP.map(([key, what]) => (
                  <span key={key}>
                    <kbd>{key}</kbd> {what}
                  </span>
                ))}
                <span>Or swipe, tap to rotate.</span>
              </p>
            )}
          </Overlay>
        </div>

        <div className={s.rail}>
          <span className={s.railLabel}>Hold</span>
          <Mini
            kind={game.hold}
            spent={game.holdUsed}
            label={game.hold ? `Hold: ${game.hold} piece` : "Hold empty"}
          />
          <span className={s.railLabel}>Next</span>
          {Array.from({ length: NEXT }, (_, i) => (
            <Mini
              key={i}
              kind={game.queue[i] ?? null}
              small={i > 0}
              label={game.queue[i] ? `Next ${i + 1}: ${game.queue[i]} piece` : `Next ${i + 1}: empty`}
            />
          ))}
        </div>
      </div>

      <div className={s.pads}>
        <DPad onDirection={onDirection} />
        <div className={s.actions}>
          <button className={`${s.act} ${s.spin}`} onClick={() => spin(-1)} aria-label="Rotate anticlockwise" disabled={!piece}>
            &#8630;
          </button>
          <button className={`${s.act} ${s.spin}`} onClick={() => spin(1)} aria-label="Rotate clockwise" disabled={!piece}>
            &#8631;
          </button>
          <button className={s.act} onClick={holdPiece} disabled={!piece || game.holdUsed}>
            Hold
          </button>
          <button className={s.act} onClick={hardDrop} disabled={!piece}>
            Drop
          </button>
        </div>
      </div>

      <StandardControls
        status={game.status}
        onPause={togglePause}
        onRestart={() => reset(startLevel, false)}
        fullscreen={isFull}
        onFullscreen={toggleFull}
        onShare={tell}
      />

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
