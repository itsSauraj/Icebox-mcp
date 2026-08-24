/**
 * @file Minesweeper: first click safe, iterative flood fill, real chording.
 *
 * Three decisions carry this game.
 *
 * The mines are laid *after* the first reveal, drawn from every cell except that
 * one and its eight neighbours, so the opening move always clears an area and
 * can never lose. A board generated up front kills roughly one game in eight on
 * the first tap, which reads as a broken app rather than as bad luck.
 *
 * The flood fill is an explicit stack. A 22 by 16 board of mostly zeros cascades
 * through hundreds of cells in a single move, which is exactly where a recursive
 * fill falls over. Seeds are checked for mines before the fill starts, which
 * lets the fill itself skip the check: it only ever expands out of a zero cell,
 * and a zero cell has no mine neighbours.
 *
 * The board is three `Uint8Array` layers (mine, count, state) rather than 350
 * cell objects, so a move copies bytes. Pointer handling is delegated to the
 * board element instead of bound per cell, and the clock lives in its own
 * component, so a tick repaints four characters and not 350 buttons.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  Segmented,
  StatusLine,
  clamp,
  isTerminal,
  seedString,
  sv,
  useBest,
  useDirectionKeys,
  useFullscreen,
  useGameLoop,
  useGameOverReport,
  useKeys,
  useSeed,
  useShare,
  type Direction,
  type GameStatus,
} from "../lib/game";
import { shuffle } from "../lib/rng";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./minesweeper.module.css";

/**
 * The classic 1 to 8 ramp, and one of the few places where the colour is the
 * content: blue, green, red, purple, rust, teal, slate, grey.
 *
 * These are hues, not finished inks. The stylesheet mixes each one into
 * `--color-text-primary`, so the ramp darkens on a light ground and lightens on
 * a dark one from a single set of values. The original palette cannot do that:
 * its navy and near-black vanish on anything dark.
 */
const NUMBER_HUE: Record<number, string> = {
  1: "#2f6bff",
  2: "#21a24a",
  3: "#ef4444",
  4: "#8b5cf6",
  5: "#e07b39",
  6: "#14b8c4",
  7: "#4b5563",
  8: "#9ca3af",
};

const FLAG = "\u{1F6A9}";
const MINE = "\u{1F4A3}";
const BOOM = "\u{1F4A5}";

type Difficulty = "easy" | "normal" | "hard";
interface Preset {
  cols: number;
  rows: number;
  mines: number;
}

const DIFFS = ["easy", "normal", "hard"] as const;
const PRESETS: Record<Difficulty, Preset> = {
  easy: { cols: 9, rows: 9, mines: 10 },
  normal: { cols: 16, rows: 16, mines: 40 },
  hard: { cols: 22, rows: 16, mines: 70 },
};

const HIDDEN = 0;
const REVEALED = 1;
const FLAGGED = 2;

/** How long a touch has to rest on a cell before it flags instead of opening. */
const HOLD_MS = 400;
/** A press that wanders further than this is a scroll attempt, not a hold. */
const HOLD_SLOP = 12;

interface Board {
  cols: number;
  rows: number;
  mines: number;
  /** False until the first reveal lays the mines. */
  armed: boolean;
  mine: Uint8Array;
  count: Uint8Array;
  state: Uint8Array;
  revealed: number;
  flags: number;
  /** Index of the mine that went off, or -1. */
  hit: number;
  status: GameStatus;
  /** `performance.now()` at the first reveal, null before the game starts. */
  startedAt: number | null;
  /** Whole seconds frozen at the terminal state, null while playing. */
  endSecs: number | null;
}

const asDifficulty = (v: string): Difficulty => (v === "easy" || v === "hard" ? v : "normal");

const centre = (p: Preset) => Math.floor(p.rows / 2) * p.cols + Math.floor(p.cols / 2);

const fmtTime = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

const elapsed = (startedAt: number | null) =>
  startedAt === null ? 0 : Math.floor((performance.now() - startedAt) / 1000);

/**
 * A blank board. No randomness here on purpose: StrictMode double-invokes state
 * initialisers, and the mines are not laid until the first click anyway.
 */
function newBoard(p: Preset): Board {
  const n = p.cols * p.rows;
  return {
    cols: p.cols,
    rows: p.rows,
    mines: p.mines,
    armed: false,
    mine: new Uint8Array(n),
    count: new Uint8Array(n),
    state: new Uint8Array(n),
    revealed: 0,
    flags: 0,
    hit: -1,
    // There is no ready state: an overlay over a fresh board would swallow the
    // very first click, which is the one click that has to land.
    status: "playing",
    startedAt: null,
    endSecs: null,
  };
}

/** The up to eight neighbours of `i`. */
function neighbours(i: number, cols: number, rows: number): number[] {
  const x = i % cols;
  const y = (i - x) / cols;
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= rows) continue;
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= cols) continue;
      out.push(ny * cols + nx);
    }
  }
  return out;
}

/**
 * Lay the mines and count them, avoiding `safe` and everything touching it.
 * Excluding the neighbours as well as the cell itself is what guarantees the
 * first reveal is a zero, and therefore opens an area rather than one square.
 * Called from the click handler, which is also where the clock starts.
 */
function arm(b: Board, safe: number): Board {
  const total = b.cols * b.rows;
  const banned = new Set<number>(neighbours(safe, b.cols, b.rows));
  banned.add(safe);

  const pool: number[] = [];
  for (let i = 0; i < total; i++) if (!banned.has(i)) pool.push(i);

  // The presets never ask for more mines than the pool holds, but clamping keeps
  // the win condition honest if one ever did.
  const want = Math.min(b.mines, pool.length);
  const mine = new Uint8Array(total);
  for (const i of shuffle(pool).slice(0, want)) mine[i] = 1;

  const count = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    if (mine[i]) continue;
    let n = 0;
    for (const j of neighbours(i, b.cols, b.rows)) n += mine[j];
    count[i] = n;
  }

  return { ...b, mine, count, mines: want, armed: true, startedAt: performance.now() };
}

/** Show every mine, keep the correct flags, remember the one that went off. */
function detonate(b: Board, hit: number): Board {
  const state = Uint8Array.from(b.state);
  for (let i = 0; i < state.length; i++) {
    if (b.mine[i] && state[i] !== FLAGGED) state[i] = REVEALED;
  }
  return { ...b, state, hit, status: "over" };
}

/** Every safe square is open, so flag the mines that are left and freeze. */
function win(b: Board): Board {
  const state = Uint8Array.from(b.state);
  for (let i = 0; i < state.length; i++) if (state[i] !== REVEALED) state[i] = FLAGGED;
  return { ...b, state, flags: b.mines, status: "won" };
}

/**
 * Open one or more cells with a single iterative flood fill. Flagged cells stop
 * the fill, which is the classic behaviour: a flag protects its square even when
 * the flag is wrong.
 */
function openCells(b: Board, seeds: number[]): Board {
  for (const i of seeds) if (b.state[i] === HIDDEN && b.mine[i]) return detonate(b, i);

  const state = Uint8Array.from(b.state);
  const stack = seeds.filter((i) => state[i] === HIDDEN);
  let revealed = b.revealed;

  while (stack.length) {
    const i = stack.pop()!;
    if (state[i] !== HIDDEN) continue;
    state[i] = REVEALED;
    revealed++;
    if (b.count[i] !== 0) continue;
    for (const j of neighbours(i, b.cols, b.rows)) if (state[j] === HIDDEN) stack.push(j);
  }

  const next = { ...b, state, revealed };
  return revealed === b.cols * b.rows - b.mines ? win(next) : next;
}

function toggleFlag(b: Board, i: number): Board {
  if (b.state[i] === REVEALED) return b;
  const state = Uint8Array.from(b.state);
  const off = state[i] === FLAGGED;
  state[i] = off ? HIDDEN : FLAGGED;
  return { ...b, state, flags: b.flags + (off ? -1 : 1) };
}

/**
 * Chording: a click on a revealed number whose flags already match it opens the
 * rest of its neighbours. This is how the game is actually played past the first
 * minute, and it is allowed to lose, because a wrong flag detonates.
 */
function chord(b: Board, i: number): Board {
  const around = neighbours(i, b.cols, b.rows);
  let flags = 0;
  for (const j of around) if (b.state[j] === FLAGGED) flags++;
  if (flags !== b.count[i]) return b;
  const shut = around.filter((j) => b.state[j] === HIDDEN);
  return shut.length ? openCells(b, shut) : b;
}

/** What one cell shows: a flag, the blast, a mine, a number, or nothing. */
function cellFace(b: Board, i: number): string {
  const st = b.state[i];
  if (st === FLAGGED) return FLAG;
  if (st !== REVEALED) return "";
  if (b.mine[i]) return i === b.hit ? BOOM : MINE;
  return b.count[i] ? String(b.count[i]) : "";
}

/** What a screen reader hears for one cell. */
function cellLabel(b: Board, i: number): string {
  const x = i % b.cols;
  const where = `row ${Math.floor(i / b.cols) + 1} column ${x + 1}`;
  const st = b.state[i];
  if (st === FLAGGED) return `${where}, flagged`;
  if (st === HIDDEN) return `${where}, hidden`;
  if (b.mine[i]) return `${where}, mine`;
  return b.count[i] ? `${where}, revealed, ${b.count[i]}` : `${where}, revealed, empty`;
}

/** The cell index under an event target, or -1 for anything outside a cell. */
function cellAt(target: EventTarget | null): number {
  const el = (target as HTMLElement | null)?.closest?.("[data-cell]");
  const raw = el instanceof HTMLElement ? el.dataset.cell : undefined;
  return raw === undefined ? -1 : Number(raw);
}

/**
 * The clock, isolated so a tick never touches the grid.
 *
 * Elapsed time is recomputed from `startedAt` on every tick rather than counted
 * up, so a throttled or backgrounded loop cannot make it drift: it just catches
 * up on the next frame it gets.
 */
function Timer({ startedAt, stopped }: { startedAt: number | null; stopped: number | null }) {
  const [secs, setSecs] = useState(0);
  const running = startedAt !== null && stopped === null;

  useGameLoop(running, 250, () => setSecs(elapsed(startedAt)));
  useEffect(() => setSecs(0), [startedAt]);

  return <>{fmtTime(stopped ?? (startedAt === null ? 0 : secs))}</>;
}

export default function Minesweeper({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);

  const seed = useSeed(runtime);
  const seeded = asDifficulty(seedString(seed, "difficulty", "normal"));

  const [diff, setDiff] = useState<Difficulty>("normal");
  const [board, setBoard] = useState<Board>(() => newBoard(PRESETS.normal));
  const boardRef = useRef(board); // authoritative, so two fast clicks cannot race
  const [cursor, setCursor] = useState(() => centre(PRESETS.normal));
  const [flagMode, setFlagMode] = useState(false);
  // The shell overlay blurs whatever is behind it, which is fine for a score but
  // hides the one thing a lost Minesweeper board is for: where the mines were.
  // So the overlay is dismissable, and New game stays in the control bar.
  const [peek, setPeek] = useState(false);

  const commit = useCallback((next: Board) => {
    // Stamping the clock here rather than inside the board functions is what
    // keeps those pure.
    const b =
      isTerminal(next.status) && next.endSecs === null
        ? { ...next, endSecs: elapsed(next.startedAt) }
        : next;
    boardRef.current = b;
    setBoard(b);
  }, []);

  const reset = useCallback((d: Difficulty) => {
    const b = newBoard(PRESETS[d]);
    boardRef.current = b;
    setBoard(b);
    setCursor(centre(PRESETS[d]));
    setPeek(false);
  }, []);

  // The seed lands after mount, so the default preset is swapped when it
  // arrives. A change from either source restarts the game.
  useEffect(() => setDiff(seeded), [seeded]);
  useEffect(() => reset(diff), [diff, reset]);

  const open = useCallback(
    (i: number) => {
      const b = boardRef.current;
      if (isTerminal(b.status) || i < 0) return;
      if (b.state[i] === FLAGGED) return; // the flag guards its square
      if (b.state[i] === REVEALED) {
        commit(chord(b, i));
        return;
      }
      commit(openCells(b.armed ? b : arm(b, i), [i]));
    },
    [commit],
  );

  const flag = useCallback(
    (i: number) => {
      const b = boardRef.current;
      if (isTerminal(b.status) || i < 0) return;
      commit(toggleFlag(b, i));
      setCursor(i);
    },
    [commit],
  );

  /* ---- Pointer input, delegated to the board ---- */

  const holdRef = useRef<{ cell: number; x: number; y: number } | null>(null);
  const timerRef = useRef<number | null>(null);
  /** True when the press in progress has already been spent on a flag. */
  const spentRef = useRef(false);

  const cancelHold = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    holdRef.current = null;
  }, []);

  useEffect(() => cancelHold, [cancelHold]);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    spentRef.current = false;
    cancelHold();
    // Desktop already has right-click, and a mouse long-press would flag every
    // time somebody clicked slowly.
    if (e.pointerType === "mouse") return;
    const i = cellAt(e.target);
    if (i < 0) return;
    holdRef.current = { cell: i, x: e.clientX, y: e.clientY };
    timerRef.current = window.setTimeout(() => {
      const hold = holdRef.current;
      timerRef.current = null;
      holdRef.current = null;
      if (!hold) return;
      spentRef.current = true;
      flag(hold.cell);
    }, HOLD_MS);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const hold = holdRef.current;
    if (!hold) return;
    if (Math.abs(e.clientX - hold.x) > HOLD_SLOP || Math.abs(e.clientY - hold.y) > HOLD_SLOP) {
      cancelHold();
    }
  };

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    cancelHold();
    if (spentRef.current) {
      spentRef.current = false; // the long press already handled this press
      return;
    }
    const i = cellAt(e.target);
    if (i < 0) return;
    if (flagMode && boardRef.current.state[i] !== REVEALED) flag(i);
    else open(i);
  };

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    // Android fires contextmenu after a long press that has already flagged.
    if (spentRef.current) return;
    flag(cellAt(e.target));
  };

  const onCellFocus = (e: FocusEvent<HTMLDivElement>) => {
    const i = cellAt(e.target);
    if (i >= 0) setCursor(i);
  };

  /* ---- Keyboard ---- */

  const moveCursor = useCallback((d: Direction) => {
    const b = boardRef.current;
    setCursor((c) => {
      const x = clamp((c % b.cols) + (d === "left" ? -1 : d === "right" ? 1 : 0), 0, b.cols - 1);
      const y = clamp(
        Math.floor(c / b.cols) + (d === "up" ? -1 : d === "down" ? 1 : 0),
        0,
        b.rows - 1,
      );
      return y * b.cols + x;
    });
  }, []);

  useDirectionKeys(moveCursor);
  useKeys({ enter: () => open(cursor), " ": () => open(cursor), f: () => flag(cursor) });

  // Roving tabindex: only the cursor cell is tabbable, and the cursor drags DOM
  // focus along with it, but only while the grid already holds focus. Otherwise
  // arrowing around would yank focus off the button the player is using.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !grid.contains(document.activeElement)) return;
    grid.querySelector<HTMLElement>(`[data-cell="${cursor}"]`)?.focus();
  }, [cursor]);

  /* ---- Derived state ---- */

  const lost = board.status === "over";
  const won = board.status === "won";
  const secs = board.endSecs ?? 0;
  const safeTotal = board.cols * board.rows - board.mines;

  // One best per preset, because a 22 by 16 time means nothing next to a 9 by 9
  // one. The two presets that are not current are fed Infinity, which leaves
  // their minimum untouched, and Infinity is also the "no win yet" value.
  const winTime = won ? secs : Infinity;
  const bestEasy = useBest(diff === "easy" ? winTime : Infinity, false);
  const bestNormal = useBest(diff === "normal" ? winTime : Infinity, false);
  const bestHard = useBest(diff === "hard" ? winTime : Infinity, false);
  const best = diff === "easy" ? bestEasy : diff === "hard" ? bestHard : bestNormal;

  useGameOverReport(runtime, isTerminal(board.status), () =>
    won
      ? `Minesweeper cleared on ${diff}, ${board.cols} by ${board.rows} with ${board.mines} mines, in ${fmtTime(secs)}.`
      : `Minesweeper lost on ${diff}: hit a mine after ${fmtTime(secs)}, ${board.revealed} of ${safeTotal} safe squares cleared.`,
  );

  const [shareStatus, share] = useShare(runtime);
  const tell = useCallback(() => {
    void share(
      won
        ? `I cleared Minesweeper on ${diff} in ${fmtTime(secs)}!`
        : `I hit a mine in Minesweeper on ${diff}.`,
      won
        ? `Minesweeper win on ${diff} in ${fmtTime(secs)}.`
        : `Minesweeper loss on ${diff} after ${fmtTime(secs)}.`,
    );
  }, [share, won, diff, secs]);

  return (
    <GameFrame
      runtime={runtime}
      innerRef={rootRef}
      fullscreen={isFull}
      wide
      className={isFull ? s.fullFrame : ""}
    >
      <GameHeader
        title="Minesweeper"
        icon={
          <span className={s.icon} aria-hidden="true">
            {MINE}
          </span>
        }
        stats={[
          { label: "Mines", value: board.mines - board.flags },
          { label: "Time", value: <Timer startedAt={board.startedAt} stopped={board.endSecs} /> },
          { label: "Best", value: best === Infinity ? "-" : fmtTime(best) },
        ]}
        hint={`${board.cols} by ${board.rows}, ${board.mines} mines`}
      />

      <Segmented label="Difficulty" options={DIFFS} value={diff} onChange={setDiff} />

      <div className={s.boardWrap} style={sv({ "--cols": board.cols, "--rows": board.rows })}>
        {/* `role="gridcell"` sits on the button itself rather than on a wrapper:
            the cell is the control, and 350 extra wrapper nodes would cost more
            than they explain. */}
        <div
          ref={gridRef}
          className={`${s.board} ${isTerminal(board.status) ? s.done : ""}`}
          role="grid"
          aria-label={`Minesweeper board, ${board.rows} rows by ${board.cols} columns`}
          aria-rowcount={board.rows}
          aria-colcount={board.cols}
          onClick={onClick}
          onContextMenu={onContextMenu}
          onFocus={onCellFocus}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={cancelHold}
          onPointerCancel={cancelHold}
          onPointerLeave={cancelHold}
        >
          {Array.from({ length: board.rows }, (_, y) => (
            <div key={y} className={s.row} role="row">
              {Array.from({ length: board.cols }, (_, x) => {
                const i = y * board.cols + x;
                const st = board.state[i];
                const isMine = board.mine[i] === 1;
                const n = board.count[i];
                const isNum = st === REVEALED && !isMine && n > 0;
                const wrongFlag = lost && st === FLAGGED && !isMine;
                return (
                  <button
                    key={x}
                    type="button"
                    role="gridcell"
                    data-cell={i}
                    className={[
                      s.cell,
                      st === REVEALED ? s.open : s.shut,
                      isNum ? s.num : "",
                      i === board.hit ? s.blast : "",
                      wrongFlag ? s.wrong : "",
                      i === cursor ? s.cursor : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    style={isNum ? sv({ "--ink": NUMBER_HUE[n] }) : undefined}
                    tabIndex={i === cursor ? 0 : -1}
                    aria-label={cellLabel(board, i)}
                  >
                    {cellFace(board, i)}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <Overlay
          status={peek ? "playing" : board.status}
          detail={
            won
              ? `All ${board.mines} mines found in ${fmtTime(secs)}.${secs === best ? " New best." : ""}`
              : `Hit a mine after ${fmtTime(secs)}. ${board.revealed} of ${safeTotal} squares cleared.`
          }
          action="Play again"
          onAction={() => reset(diff)}
          secondary="See the board"
          onSecondary={() => setPeek(true)}
        />
      </div>

      <ControlBar>
        <button
          className={`${ui.btn} ${flagMode ? ui.primary : ""}`}
          aria-pressed={flagMode}
          onClick={() => setFlagMode((v) => !v)}
        >
          {FLAG} Flag mode
        </button>
        <button className={ui.btn} onClick={() => reset(diff)}>
          New game
        </button>
        <button className={ui.btn} onClick={toggleFull}>
          {isFull ? "Exit fullscreen" : "Fullscreen"}
        </button>
        <button className={ui.btn} onClick={tell} disabled={!isTerminal(board.status)}>
          Tell the model
        </button>
      </ControlBar>

      <Notice>
        Click or Enter opens, arrows move. Right-click, long press or F flags. Click a number whose
        flags match it to open the rest.
      </Notice>

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
