/**
 * @file Nonogram: fill cells from row and column clues to reveal a picture.
 *
 * The twist that makes this an MCP game is that the model draws the picture:
 * it sends a bitmap as rows of characters, the server normalises it to a
 * rectangle, and the clues are derived from it here. With no bitmap the app
 * falls back to its own string art.
 *
 * Marking blanks is not decoration, it is how nonograms are actually solved,
 * so the third cell state carries equal weight with filling. Drag paints a run
 * in whatever state the drag started in, locked to one axis once the direction
 * is established, which is how every good implementation behaves.
 *
 * There is no mistake counter. Counting mistakes turns a puzzle into an exam,
 * and the player cannot always tell a deduction from a guess. A check button
 * reports how many cells are wrong without saying which, and counts its own
 * uses, which is honest without being punitive.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { randInt } from "../lib/rng";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  Segmented,
  StatusLine,
  clamp,
  seedArray,
  sv,
  useBest,
  useDirectionKeys,
  useFullscreen,
  useGameOverReport,
  useKeys,
  useSeed,
  useShare,
  type Direction,
  type GameStatus,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./nonogram.module.css";

/** Built-in pictures, used when the model sends no bitmap. */
const BUILT_IN: { name: string; rows: string[] }[] = [
  {
    name: "Cat",
    rows: [
      "##......##",
      "###....###",
      "##########",
      "#.######.#",
      "##########",
      "##########",
      "#.##..##.#",
      "##.####.##",
      ".##....##.",
      "..######..",
    ],
  },
  {
    name: "Heart",
    rows: [
      ".##....##.",
      "####..####",
      "##########",
      "##########",
      "##########",
      ".########.",
      "..######..",
      "...####...",
      "....##....",
      "..........",
    ],
  },
  {
    name: "Key",
    rows: [
      "..####....",
      ".##..##...",
      ".##..##...",
      "..####....",
      "...##.....",
      "...##.....",
      "...####...",
      "...##.....",
      "...####...",
      "..........",
    ],
  },
  {
    name: "Boat",
    rows: [
      "....#.....",
      "....##....",
      "....###...",
      "....####..",
      "....#.....",
      "....#.....",
      "..######..",
      ".########.",
      "..######..",
      "..........",
    ],
  },
  {
    name: "Umbrella",
    rows: [
      "...####...",
      "..######..",
      ".########.",
      "##########",
      "#.##..##.#",
      "....##....",
      "....##....",
      "....##....",
      "...###....",
      "..###.....",
    ],
  },
];

type Cell = 0 | 1 | 2; // empty, filled, marked blank
type Mode = "fill" | "mark";

/** Run lengths of consecutive filled cells. An empty line is [0]. */
function clueFor(line: boolean[]): number[] {
  const out: number[] = [];
  let run = 0;
  for (const on of line) {
    if (on) run++;
    else if (run > 0) {
      out.push(run);
      run = 0;
    }
  }
  if (run > 0) out.push(run);
  return out.length ? out : [0];
}

/** Does this line's filled pattern satisfy its clue exactly? */
const lineSatisfied = (line: boolean[], clue: number[]) => {
  const got = clueFor(line);
  return got.length === clue.length && got.every((n, i) => n === clue[i]);
};

interface Puzzle {
  name: string;
  rows: number;
  cols: number;
  solution: boolean[][];
  rowClues: number[][];
  colClues: number[][];
  filledTotal: number;
}

function buildPuzzle(name: string, grid: boolean[][]): Puzzle {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const rowClues = grid.map(clueFor);
  const colClues: number[][] = [];
  for (let c = 0; c < cols; c++) colClues.push(clueFor(grid.map((row) => row[c])));
  return {
    name,
    rows,
    cols,
    solution: grid,
    rowClues,
    colClues,
    filledTotal: grid.flat().filter(Boolean).length,
  };
}

const fromStrings = (name: string, rows: string[]): Puzzle =>
  buildPuzzle(name, rows.map((r) => Array.from(r, (ch) => ch !== "." && ch !== " " && ch !== "0" && ch !== "_")));

/** Validate a model bitmap. The server has already rectangularised it. */
function fromSeed(raw: unknown[]): Puzzle | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const grid: boolean[][] = [];
  for (const row of raw) {
    if (!Array.isArray(row)) return null;
    grid.push(row.map((v) => Boolean(v)));
  }
  const width = grid[0].length;
  if (width === 0 || width > 15 || grid.length > 15) return null;
  if (!grid.every((r) => r.length === width)) return null;
  if (!grid.some((r) => r.some(Boolean))) return null;
  return buildPuzzle("From the model", grid);
}

const emptyBoard = (rows: number, cols: number): Cell[][] =>
  Array.from({ length: rows }, () => new Array<Cell>(cols).fill(0));

export default function Nonogram({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seedRaw = useSeed(runtime);
  const bitmap = useMemo(() => seedArray<unknown>(seedRaw, "bitmap"), [seedRaw]);

  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [board, setBoard] = useState<Cell[][]>([]);
  const [mode, setMode] = useState<Mode>("fill");
  const [cursor, setCursor] = useState({ r: 0, c: 0 });
  const [checks, setChecks] = useState(0);
  const [wrongCount, setWrongCount] = useState<number | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [started, setStarted] = useState(false);
  const [won, setWon] = useState(false);

  // Drag state, kept in a ref so a paint does not re-render on every pointer move.
  const drag = useRef<{ to: Cell; axis: null | "row" | "col"; from: { r: number; c: number } } | null>(null);

  const start = useCallback((p: Puzzle) => {
    setPuzzle(p);
    setBoard(emptyBoard(p.rows, p.cols));
    setCursor({ r: 0, c: 0 });
    setChecks(0);
    setWrongCount(null);
    setSeconds(0);
    setStarted(false);
    setWon(false);
  }, []);

  // Pick a built-in on mount. Randomness lives here rather than in a state
  // initialiser, which StrictMode would run twice.
  useEffect(() => {
    if (puzzle) return;
    const pick = BUILT_IN[randInt(0, BUILT_IN.length - 1)];
    start(fromStrings(pick.name, pick.rows));
  }, [puzzle, start]);

  // A model bitmap replaces whatever is on screen.
  const sig = useMemo(() => JSON.stringify(bitmap), [bitmap]);
  const lastSig = useRef("");
  useEffect(() => {
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    const fresh = fromSeed(bitmap);
    if (fresh) start(fresh);
  }, [sig, bitmap, start]);

  // Timer. Starts on the first paint, stops on a win.
  useEffect(() => {
    if (!started || won) return;
    const id = window.setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [started, won]);

  const best = useBest(won ? seconds : Infinity, false);

  const filledCount = useMemo(
    () => board.reduce((n, row) => n + row.filter((c) => c === 1).length, 0),
    [board],
  );

  /** Win when the filled cells match the solution exactly. Blank marks ignored. */
  const checkWin = useCallback(
    (next: Cell[][]) => {
      if (!puzzle) return false;
      for (let r = 0; r < puzzle.rows; r++) {
        for (let c = 0; c < puzzle.cols; c++) {
          if ((next[r][c] === 1) !== puzzle.solution[r][c]) return false;
        }
      }
      return true;
    },
    [puzzle],
  );

  const paint = useCallback(
    (r: number, c: number, to: Cell) => {
      if (!puzzle || won) return;
      setStarted(true);
      setWrongCount(null);
      setBoard((prev) => {
        if (prev[r]?.[c] === undefined || prev[r][c] === to) return prev;
        const next = prev.map((row) => row.slice());
        next[r][c] = to;
        if (checkWin(next)) setWon(true);
        return next;
      });
    },
    [puzzle, won, checkWin],
  );

  /** Tapping a cell cycles it between empty and the current mode's state. */
  const cycleAt = useCallback(
    (r: number, c: number): Cell => {
      const want: Cell = mode === "fill" ? 1 : 2;
      return board[r]?.[c] === want ? 0 : want;
    },
    [mode, board],
  );

  const onPointerDown = useCallback(
    (r: number, c: number, e: PointerEvent<HTMLButtonElement>) => {
      if (won) return;
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      const to = cycleAt(r, c);
      drag.current = { to, axis: null, from: { r, c } };
      paint(r, c, to);
    },
    [won, cycleAt, paint],
  );

  /**
   * Continue a drag. The first cell that differs from the anchor fixes the
   * axis, and everything after is constrained to it, so a sloppy diagonal
   * still paints one clean run.
   */
  const onPointerEnter = useCallback(
    (r: number, c: number) => {
      const d = drag.current;
      if (!d) return;
      if (d.axis === null) {
        if (r === d.from.r && c === d.from.c) return;
        d.axis = r === d.from.r ? "row" : "col";
      }
      if (d.axis === "row" && r !== d.from.r) return;
      if (d.axis === "col" && c !== d.from.c) return;
      paint(r, c, d.to);
    },
    [paint],
  );

  useEffect(() => {
    const end = () => {
      drag.current = null;
    };
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
    };
  }, []);

  const check = useCallback(() => {
    if (!puzzle) return;
    let wrong = 0;
    for (let r = 0; r < puzzle.rows; r++) {
      for (let c = 0; c < puzzle.cols; c++) {
        if ((board[r][c] === 1) !== puzzle.solution[r][c]) wrong++;
      }
    }
    setChecks((n) => n + 1);
    setWrongCount(wrong);
  }, [puzzle, board]);

  const onDirection = useCallback(
    (dir: Direction) => {
      if (!puzzle) return;
      setCursor((p) => ({
        r: clamp(p.r + (dir === "up" ? -1 : dir === "down" ? 1 : 0), 0, puzzle.rows - 1),
        c: clamp(p.c + (dir === "left" ? -1 : dir === "right" ? 1 : 0), 0, puzzle.cols - 1),
      }));
    },
    [puzzle],
  );

  useDirectionKeys(onDirection, undefined, !won);
  useKeys({
    " ": () => paint(cursor.r, cursor.c, board[cursor.r]?.[cursor.c] === 1 ? 0 : 1),
    x: () => paint(cursor.r, cursor.c, board[cursor.r]?.[cursor.c] === 2 ? 0 : 2),
    enter: check,
  });

  useGameOverReport(runtime, won, () =>
    `Nonogram "${puzzle?.name ?? "picture"}" solved in ${seconds} seconds with ${checks} checks.`,
  );

  const askForAnother = useCallback(() => {
    void share(
      "Draw me another nonogram, a 10 by 10 bitmap of something recognisable.",
      `Nonogram solved in ${seconds} seconds.`,
    );
  }, [share, seconds]);

  const newBuiltIn = useCallback(() => {
    const pick = BUILT_IN[randInt(0, BUILT_IN.length - 1)];
    start(fromStrings(pick.name, pick.rows));
  }, [start]);

  if (!puzzle) {
    return (
      <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide>
        <GameHeader title="Nonogram" hint="Building a picture" />
      </GameFrame>
    );
  }

  const status: GameStatus = won ? "won" : "playing";
  const rowsDone = puzzle.rowClues.map((clue, r) =>
    lineSatisfied(board[r].map((c) => c === 1), clue),
  );
  const colsDone = puzzle.colClues.map((clue, c) =>
    lineSatisfied(board.map((row) => row[c] === 1), clue),
  );
  const maxRowClue = Math.max(...puzzle.rowClues.map((c) => c.length));
  const maxColClue = Math.max(...puzzle.colClues.map((c) => c.length));

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Nonogram"
        stats={[
          { label: "Filled", value: `${filledCount}/${puzzle.filledTotal}` },
          { label: "Time", value: `${seconds}s` },
          { label: "Checks", value: checks },
        ]}
        hint={won ? undefined : mode === "fill" ? "Drag to fill a run" : "Drag to mark blanks"}
      />

      <div className={s.boardWrap}>
        <div
          className={`${s.layout} ${won ? s.revealed : ""}`}
          style={sv({ "--cols": puzzle.cols, "--rows": puzzle.rows, "--rc": maxRowClue, "--cc": maxColClue })}
        >
          <div className={s.corner} />

          <div className={s.colClues}>
            {puzzle.colClues.map((clue, c) => (
              <div key={c} className={`${s.colClue} ${colsDone[c] ? s.clueDone : ""}`}>
                {clue.map((n, i) => (
                  <span key={i}>{n === 0 ? "" : n}</span>
                ))}
              </div>
            ))}
          </div>

          <div className={s.rowClues}>
            {puzzle.rowClues.map((clue, r) => (
              <div key={r} className={`${s.rowClue} ${rowsDone[r] ? s.clueDone : ""}`}>
                {clue.map((n, i) => (
                  <span key={i}>{n === 0 ? "" : n}</span>
                ))}
              </div>
            ))}
          </div>

          <div className={s.grid} role="grid" aria-label={`Nonogram, ${puzzle.rows} by ${puzzle.cols}`}>
            {board.map((row, r) =>
              row.map((cell, c) => (
                <button
                  key={`${r}-${c}`}
                  type="button"
                  role="gridcell"
                  className={`${s.cell} ${cell === 1 ? s.filled : ""} ${cell === 2 ? s.marked : ""} ${
                    cursor.r === r && cursor.c === c ? s.cursor : ""
                  } ${r % 5 === 4 ? s.blockRow : ""} ${c % 5 === 4 ? s.blockCol : ""}`}
                  tabIndex={cursor.r === r && cursor.c === c ? 0 : -1}
                  onFocus={() => setCursor({ r, c })}
                  onPointerDown={(e) => onPointerDown(r, c, e)}
                  onPointerEnter={() => onPointerEnter(r, c)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    paint(r, c, cell === 2 ? 0 : 2);
                  }}
                  aria-label={`Row ${r + 1} column ${c + 1}, ${cell === 1 ? "filled" : cell === 2 ? "marked blank" : "empty"}`}
                />
              )),
            )}
          </div>
        </div>

        <Overlay
          status={status}
          title={puzzle.name}
          detail={`Solved in ${seconds} seconds with ${checks} check${checks === 1 ? "" : "s"}.`}
          action="Another picture"
          onAction={askForAnother}
          secondary="Built-in puzzle"
          onSecondary={newBuiltIn}
        />
      </div>

      <ControlBar>
        <Segmented
          label="Mode"
          options={[
            { value: "fill" as Mode, label: "Fill" },
            { value: "mark" as Mode, label: "Mark blank" },
          ]}
          value={mode}
          onChange={setMode}
        />
      </ControlBar>

      <ControlBar>
        <button className={`${ui.btn} ${ui.primary}`} onClick={check} disabled={won}>
          Check
        </button>
        <button className={ui.btn} onClick={newBuiltIn}>
          New picture
        </button>
        <button className={ui.btn} onClick={toggleFull}>
          {isFull ? "Exit fullscreen" : "Fullscreen"}
        </button>
        <button className={ui.btn} onClick={askForAnother}>
          Ask the model
        </button>
      </ControlBar>

      <p className={ui.status} role="status" aria-live="polite">
        {wrongCount === null
          ? ""
          : wrongCount === 0
            ? "Everything filled so far is correct."
            : `${wrongCount} cell${wrongCount === 1 ? "" : "s"} wrong.`}
      </p>

      {best !== Infinity && !won && <Notice>Best time so far: {best}s.</Notice>}

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
