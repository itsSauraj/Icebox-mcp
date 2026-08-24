/**
 * @file Sudoku with a real generator and a real solver. No lookup table.
 *
 * Generation is the interesting part:
 *
 *  1. Fill a complete valid grid by backtracking with a randomised candidate
 *     order. The three diagonal boxes are independent, so seeding those first
 *     from shuffled digits makes the rest fall out fast.
 *  2. Remove clues one at a time, in a shuffled order, and after every removal
 *     check that the puzzle still has **exactly one** solution. A puzzle with
 *     two answers is one the player will notice and rightly resent, so the
 *     uniqueness check is what makes the puzzle honest rather than merely
 *     generated.
 *  3. Rate what is left by running a logic-only solver that applies naked
 *     singles and hidden singles. If that finishes, the puzzle needs no
 *     guessing; if it stalls, the puzzle is hard.
 *
 * The solution counter stops at two, which is the whole trick that keeps
 * generation fast: proving "more than one" never requires enumerating them all.
 *
 * Generation runs in an effect, never a state initialiser, because it uses
 * randomness and StrictMode double-invokes initialisers.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shuffle } from "../lib/rng";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  Segmented,
  StatusLine,
  clamp,
  seedString,
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
import s from "./sudoku.module.css";

const N = 9;
const CELLS = 81;
const DIGITS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

const DIFFICULTIES = ["easy", "normal", "hard", "expert"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];
const isDifficulty = (v: string): v is Difficulty => (DIFFICULTIES as readonly string[]).includes(v);

/** Target clue counts. Fewer clues is not the same as harder, but it correlates. */
const CLUE_TARGET: Record<Difficulty, number> = { easy: 40, normal: 32, hard: 28, expert: 24 };

const rowOf = (i: number) => Math.floor(i / N);
const colOf = (i: number) => i % N;
const boxOf = (i: number) => Math.floor(rowOf(i) / 3) * 3 + Math.floor(colOf(i) / 3);

/** Peers of each cell, precomputed once: same row, column or box. */
const PEERS: number[][] = (() => {
  const out: number[][] = [];
  for (let i = 0; i < CELLS; i++) {
    const set = new Set<number>();
    for (let j = 0; j < CELLS; j++) {
      if (j === i) continue;
      if (rowOf(j) === rowOf(i) || colOf(j) === colOf(i) || boxOf(j) === boxOf(i)) set.add(j);
    }
    out.push([...set]);
  }
  return out;
})();

const UNITS: number[][] = (() => {
  const out: number[][] = [];
  for (let r = 0; r < N; r++) out.push(Array.from({ length: N }, (_, c) => r * N + c));
  for (let c = 0; c < N; c++) out.push(Array.from({ length: N }, (_, r) => r * N + c));
  for (let b = 0; b < N; b++) {
    const cells: number[] = [];
    const r0 = Math.floor(b / 3) * 3;
    const c0 = (b % 3) * 3;
    for (let r = r0; r < r0 + 3; r++) for (let c = c0; c < c0 + 3; c++) cells.push(r * N + c);
    out.push(cells);
  }
  return out;
})();

const legal = (grid: number[], i: number, v: number) => !PEERS[i].some((p) => grid[p] === v);

/** Fill a complete valid grid by randomised backtracking. */
function solvedGrid(): number[] {
  const grid = new Array<number>(CELLS).fill(0);

  // The three diagonal boxes share no peers, so they can be filled freely and
  // give the backtracker a big head start.
  for (const b of [0, 4, 8]) {
    const cells = UNITS[18 + b];
    const digits = shuffle(DIGITS);
    cells.forEach((cell, k) => {
      grid[cell] = digits[k];
    });
  }

  const fill = (i: number): boolean => {
    if (i >= CELLS) return true;
    if (grid[i] !== 0) return fill(i + 1);
    for (const v of shuffle(DIGITS)) {
      if (!legal(grid, i, v)) continue;
      grid[i] = v;
      if (fill(i + 1)) return true;
      grid[i] = 0;
    }
    return false;
  };

  fill(0);
  return grid;
}

/**
 * How many solutions the puzzle has, counted only up to `cap`. Stopping at two
 * is what makes the uniqueness check affordable: proving "more than one" never
 * needs the full enumeration.
 */
function countSolutions(puzzle: number[], cap = 2): number {
  const grid = puzzle.slice();
  let found = 0;

  const search = (): void => {
    if (found >= cap) return;
    // Constrain hardest first: the cell with fewest candidates.
    let bestCell = -1;
    let bestOptions: number[] = [];
    for (let i = 0; i < CELLS; i++) {
      if (grid[i] !== 0) continue;
      const options = DIGITS.filter((v) => legal(grid, i, v));
      if (options.length === 0) return;
      if (bestCell === -1 || options.length < bestOptions.length) {
        bestCell = i;
        bestOptions = options;
        if (options.length === 1) break;
      }
    }
    if (bestCell === -1) {
      found++;
      return;
    }
    for (const v of bestOptions) {
      grid[bestCell] = v;
      search();
      grid[bestCell] = 0;
      if (found >= cap) return;
    }
  };

  search();
  return found;
}

/**
 * Solve using only naked singles and hidden singles. Returns true when the
 * puzzle falls out by logic alone, which is what separates easy and normal
 * from hard and expert.
 */
function solvableByLogic(puzzle: number[]): boolean {
  const grid = puzzle.slice();
  for (;;) {
    let placed = false;

    // Naked single: a cell with exactly one candidate.
    for (let i = 0; i < CELLS; i++) {
      if (grid[i] !== 0) continue;
      const options = DIGITS.filter((v) => legal(grid, i, v));
      if (options.length === 0) return false;
      if (options.length === 1) {
        grid[i] = options[0];
        placed = true;
      }
    }

    // Hidden single: a digit with exactly one home in a unit.
    for (const unit of UNITS) {
      for (const v of DIGITS) {
        if (unit.some((i) => grid[i] === v)) continue;
        const homes = unit.filter((i) => grid[i] === 0 && legal(grid, i, v));
        if (homes.length === 1) {
          grid[homes[0]] = v;
          placed = true;
        }
      }
    }

    if (!placed) break;
  }
  return grid.every((v) => v !== 0);
}

interface Puzzle {
  givens: number[];
  solution: number[];
  difficulty: Difficulty;
  clues: number;
}

/** Generate a puzzle whose difficulty band matches the request. */
function generate(difficulty: Difficulty): Puzzle {
  const solution = solvedGrid();
  const puzzle = solution.slice();
  const target = CLUE_TARGET[difficulty];
  const wantLogic = difficulty === "easy" || difficulty === "normal";

  let clues = CELLS;
  for (const i of shuffle(Array.from({ length: CELLS }, (_, k) => k))) {
    if (clues <= target) break;
    const saved = puzzle[i];
    if (saved === 0) continue;
    puzzle[i] = 0;
    // The removal only stands if the answer is still the only answer.
    if (countSolutions(puzzle) !== 1) {
      puzzle[i] = saved;
      continue;
    }
    clues--;
  }

  // Nudge the rating toward the band that was asked for. One retry, because
  // generation must stay well under a couple of hundred milliseconds.
  const byLogic = solvableByLogic(puzzle);
  if (byLogic !== wantLogic) {
    const second = solution.slice();
    let c2 = CELLS;
    const bias = wantLogic ? target + 4 : target - 2;
    for (const i of shuffle(Array.from({ length: CELLS }, (_, k) => k))) {
      if (c2 <= bias) break;
      const saved = second[i];
      if (saved === 0) continue;
      second[i] = 0;
      if (countSolutions(second) !== 1) {
        second[i] = saved;
        continue;
      }
      c2--;
    }
    if (solvableByLogic(second) === wantLogic) {
      return { givens: second, solution, difficulty, clues: c2 };
    }
  }

  return { givens: puzzle, solution, difficulty, clues };
}

type Marks = Set<number>[];

const emptyMarks = (): Marks => Array.from({ length: CELLS }, () => new Set<number>());

interface Snapshot {
  values: number[];
  marks: Marks;
}

const cloneMarks = (m: Marks): Marks => m.map((set) => new Set(set));

export default function Sudoku({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [values, setValues] = useState<number[]>([]);
  const [marks, setMarks] = useState<Marks>(emptyMarks);
  const [history, setHistory] = useState<Snapshot[]>([]);
  const [cursor, setCursor] = useState(0);
  const [notes, setNotes] = useState(false);
  const [autoClear, setAutoClear] = useState(true);
  const [hints, setHints] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const [building, setBuilding] = useState(true);

  const solved = useMemo(
    () => Boolean(puzzle) && values.length === CELLS && values.every((v, i) => v === puzzle!.solution[i]),
    [values, puzzle],
  );

  const build = useCallback((d: Difficulty) => {
    setBuilding(true);
    // Yield a frame so the building state paints before the work starts.
    window.setTimeout(() => {
      const p = generate(d);
      setPuzzle(p);
      setValues(p.givens.slice());
      setMarks(emptyMarks());
      setHistory([]);
      setHints(0);
      setSeconds(0);
      setCursor(p.givens.findIndex((v) => v === 0));
      setBuilding(false);
    }, 16);
  }, []);

  useEffect(() => {
    build(difficulty);
    // Only on an explicit difficulty change, never on every render.
  }, [difficulty, build]);

  useEffect(() => {
    const d = seedString(seed, "difficulty");
    if (d && isDifficulty(d)) setDifficulty(d);
  }, [seed]);

  useEffect(() => {
    if (building || solved) return;
    const id = window.setInterval(() => setSeconds((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [building, solved]);

  const best = useBest(solved ? seconds : Infinity, false);

  const push = useCallback(() => {
    setHistory((h) => [...h.slice(-40), { values: values.slice(), marks: cloneMarks(marks) }]);
  }, [values, marks]);

  const isGiven = useCallback((i: number) => Boolean(puzzle) && puzzle!.givens[i] !== 0, [puzzle]);

  const place = useCallback(
    (i: number, v: number) => {
      if (!puzzle || solved || isGiven(i)) return;
      push();
      setValues((prev) => {
        const next = prev.slice();
        next[i] = next[i] === v ? 0 : v;
        return next;
      });
      setMarks((prev) => {
        const next = cloneMarks(prev);
        next[i] = new Set();
        // Clearing the digit from peers' pencil marks is the single biggest
        // convenience in a Sudoku app, so it defaults on.
        if (autoClear && v !== 0) for (const p of PEERS[i]) next[p].delete(v);
        return next;
      });
    },
    [puzzle, solved, isGiven, push, autoClear],
  );

  const toggleMark = useCallback(
    (i: number, v: number) => {
      if (!puzzle || solved || isGiven(i) || values[i] !== 0) return;
      push();
      setMarks((prev) => {
        const next = cloneMarks(prev);
        if (next[i].has(v)) next[i].delete(v);
        else next[i].add(v);
        return next;
      });
    },
    [puzzle, solved, isGiven, values, push],
  );

  const enter = useCallback(
    (v: number) => (notes ? toggleMark(cursor, v) : place(cursor, v)),
    [notes, toggleMark, place, cursor],
  );

  const clearCell = useCallback(() => {
    if (!puzzle || isGiven(cursor)) return;
    push();
    setValues((prev) => {
      const next = prev.slice();
      next[cursor] = 0;
      return next;
    });
    setMarks((prev) => {
      const next = cloneMarks(prev);
      next[cursor] = new Set();
      return next;
    });
  }, [puzzle, isGiven, cursor, push]);

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      const last = h[h.length - 1];
      setValues(last.values);
      setMarks(last.marks);
      return h.slice(0, -1);
    });
  }, []);

  /** Fill the most constrained empty cell with its correct digit. */
  const hint = useCallback(() => {
    if (!puzzle || solved) return;
    let target = -1;
    let fewest = 10;
    for (let i = 0; i < CELLS; i++) {
      if (values[i] !== 0) continue;
      const options = DIGITS.filter((v) => legal(values, i, v)).length;
      if (options < fewest) {
        fewest = options;
        target = i;
      }
    }
    if (target === -1) return;
    push();
    setHints((n) => n + 1);
    setCursor(target);
    setValues((prev) => {
      const next = prev.slice();
      next[target] = puzzle.solution[target];
      return next;
    });
    setMarks((prev) => {
      const next = cloneMarks(prev);
      next[target] = new Set();
      for (const p of PEERS[target]) next[p].delete(puzzle.solution[target]);
      return next;
    });
  }, [puzzle, solved, values, push]);

  const onDirection = useCallback(
    (dir: Direction) => {
      const r = rowOf(cursor);
      const c = colOf(cursor);
      const dr = dir === "up" ? -1 : dir === "down" ? 1 : 0;
      const dc = dir === "left" ? -1 : dir === "right" ? 1 : 0;
      setCursor(clamp(r + dr, 0, N - 1) * N + clamp(c + dc, 0, N - 1));
    },
    [cursor],
  );

  useDirectionKeys(onDirection, undefined, !building);
  useKeys({
    "1": () => enter(1), "2": () => enter(2), "3": () => enter(3),
    "4": () => enter(4), "5": () => enter(5), "6": () => enter(6),
    "7": () => enter(7), "8": () => enter(8), "9": () => enter(9),
    "0": clearCell,
    backspace: clearCell,
    delete: clearCell,
    n: () => setNotes((v) => !v),
    z: undo,
    h: hint,
  });

  useGameOverReport(runtime, solved, () =>
    `Sudoku (${difficulty}) solved in ${seconds} seconds with ${hints} hint${hints === 1 ? "" : "s"}.`,
  );

  const tell = useCallback(() => {
    void share(
      `I solved a ${difficulty} Sudoku in ${seconds} seconds${hints ? ` using ${hints} hints` : " with no hints"}.`,
      `Sudoku: ${puzzle?.clues ?? 0} clues.`,
    );
  }, [share, difficulty, seconds, hints, puzzle]);

  /** Cells that duplicate a digit within a unit. A soft warning, not an error. */
  const conflicts = useMemo(() => {
    const bad = new Set<number>();
    for (let i = 0; i < CELLS; i++) {
      const v = values[i];
      if (!v) continue;
      if (PEERS[i].some((p) => values[p] === v)) bad.add(i);
    }
    return bad;
  }, [values]);

  const remaining = values.filter((v) => v === 0).length;
  const placedCount = useMemo(() => {
    const counts = new Array(10).fill(0);
    for (const v of values) if (v) counts[v]++;
    return counts;
  }, [values]);

  const status: GameStatus = solved ? "won" : "playing";
  const selected = values[cursor] ?? 0;

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Sudoku"
        stats={[
          { label: "Time", value: `${seconds}s` },
          { label: "Empty", value: remaining },
          { label: "Hints", value: hints },
        ]}
        hint={building ? "Building a puzzle" : notes ? "Notes mode" : undefined}
      />

      {building || !puzzle ? (
        <Notice>Building a puzzle with exactly one solution.</Notice>
      ) : (
        <>
          <div className={s.boardWrap}>
            <div className={s.grid} role="grid" aria-label="Sudoku grid">
              {values.map((v, i) => {
                const given = isGiven(i);
                const isCursor = i === cursor;
                const peer = !isCursor && PEERS[cursor].includes(i);
                const same = v !== 0 && v === selected && !isCursor;
                return (
                  <button
                    key={i}
                    type="button"
                    role="gridcell"
                    className={[
                      s.cell,
                      given ? s.given : "",
                      isCursor ? s.cursor : "",
                      peer ? s.peer : "",
                      same ? s.same : "",
                      conflicts.has(i) ? s.conflict : "",
                      colOf(i) % 3 === 2 && colOf(i) !== 8 ? s.boxRight : "",
                      rowOf(i) % 3 === 2 && rowOf(i) !== 8 ? s.boxBottom : "",
                    ].join(" ")}
                    tabIndex={isCursor ? 0 : -1}
                    onFocus={() => setCursor(i)}
                    onClick={() => setCursor(i)}
                    aria-label={`Row ${rowOf(i) + 1} column ${colOf(i) + 1}, ${
                      v === 0 ? "empty" : given ? `${v}, given` : String(v)
                    }`}
                  >
                    {v !== 0 ? (
                      <span className={s.value}>{v}</span>
                    ) : marks[i].size > 0 ? (
                      <span className={s.marks} aria-hidden="true">
                        {DIGITS.map((d) => (
                          <span key={d} className={marks[i].has(d) ? s.markOn : s.markOff}>
                            {marks[i].has(d) ? d : ""}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            <Overlay
              status={status}
              title="Solved"
              detail={`${difficulty}, ${seconds} seconds, ${hints} hint${hints === 1 ? "" : "s"}.`}
              action="New puzzle"
              onAction={() => build(difficulty)}
            />
          </div>

          <div className={s.pad} role="group" aria-label="Digits">
            {DIGITS.map((d) => (
              <button
                key={d}
                className={`${s.padKey} ${placedCount[d] >= N ? s.padDone : ""}`}
                onClick={() => enter(d)}
                disabled={solved}
                aria-label={`${notes ? "Toggle note" : "Place"} ${d}${placedCount[d] >= N ? ", all placed" : ""}`}
              >
                {d}
                <span className={s.padCount}>{N - placedCount[d] > 0 ? N - placedCount[d] : ""}</span>
              </button>
            ))}
            <button className={s.padKey} onClick={clearCell} disabled={solved} aria-label="Clear cell">
              &times;
            </button>
          </div>

          <ControlBar>
            <button
              className={`${ui.btn} ${notes ? ui.primary : ""}`}
              aria-pressed={notes}
              onClick={() => setNotes((v) => !v)}
            >
              Notes
            </button>
            <button className={ui.btn} onClick={undo} disabled={history.length === 0}>
              Undo
            </button>
            <button className={ui.btn} onClick={hint} disabled={solved}>
              Hint
            </button>
            <button
              className={`${ui.btn} ${autoClear ? ui.primary : ""}`}
              aria-pressed={autoClear}
              onClick={() => setAutoClear((v) => !v)}
            >
              Auto-clear
            </button>
          </ControlBar>

          <ControlBar>
            <Segmented label="Difficulty" options={DIFFICULTIES} value={difficulty} onChange={setDifficulty} />
          </ControlBar>

          <ControlBar>
            <button className={ui.btn} onClick={() => build(difficulty)}>
              New puzzle
            </button>
            <button className={ui.btn} onClick={toggleFull}>
              {isFull ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <button className={ui.btn} onClick={tell} disabled={!solved}>
              Tell the model
            </button>
          </ControlBar>

          <p className={ui.status} role="status" aria-live="polite">
            {conflicts.size > 0 ? `${conflicts.size} cells conflict.` : ""}
          </p>

          {best !== Infinity && !solved && <Notice>Best time so far: {best}s.</Notice>}
        </>
      )}

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
