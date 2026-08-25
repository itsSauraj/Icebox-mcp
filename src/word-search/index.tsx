/**
 * @file Word Search: themed grid, drag or keyboard to select.
 *
 * The generator is the real work. It places every word in a shuffled list of
 * every in-bounds placement for that word (all eight directions, forwards and
 * backwards), taking the first candidate whose overlaps already agree with
 * the letters being written. That list is finite and exhausted before giving
 * up, so a word is dropped from the shown list only when it truly cannot fit
 * anywhere, never left in the list unplaced. Remaining cells are filled with
 * letters weighted toward ones already placed, so the noise does not read as
 * obviously random. Generation happens in an effect once the seed (or the
 * fallback) is known, because it uses randomness and a `useState` initialiser
 * would see two different boards under StrictMode's double invocation.
 *
 * Selection is one function shared by both input paths: given an anchor cell
 * and a row/column offset, `buildPath` snaps to the nearest of the eight
 * straight lines and walks it only as far as the offset actually reaches.
 * Pointer drag feeds it a pixel offset divided by the measured cell size;
 * the keyboard feeds it the offset between the anchor and the roving cursor
 * in whole cells. Neither path needs to know about the other.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import {
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  StandardControls,
  StatusLine,
  clamp,
  seedArray,
  seedString,
  sv,
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
import { pick, shuffle } from "../lib/rng";
import type { AppProps } from "../lib/runtime";
import s from "./wordsearch.module.css";

interface Cell {
  row: number;
  col: number;
}

interface PlacedWord {
  word: string;
  cells: Cell[];
}

interface Puzzle {
  size: number;
  grid: string[][];
  /** Words that actually made it into the grid. A word that could not be
   *  placed anywhere is simply absent, never shown unplaced. */
  placed: PlacedWord[];
}

/** No words from the model: a compact themed set written by hand. */
const FALLBACK_TOPIC = "Space";
const FALLBACK_WORDS = [
  "planet",
  "comet",
  "rocket",
  "galaxy",
  "meteor",
  "nebula",
  "cosmos",
  "orbit",
  "saturn",
  "asteroid",
];

const MIN_LEN = 3;
const MAX_LEN = 12;
const MAX_WORDS = 12;

/** Lowercase, letters only, deduped, length-bounded, capped at MAX_WORDS. */
function sanitizeWords(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const w = item.toLowerCase().replace(/[^a-z]/g, "");
    if (w.length < MIN_LEN || w.length > MAX_LEN || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= MAX_WORDS) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

const DIRECTIONS: Cell[] = [
  { row: -1, col: 0 },
  { row: 1, col: 0 },
  { row: 0, col: -1 },
  { row: 0, col: 1 },
  { row: -1, col: -1 },
  { row: -1, col: 1 },
  { row: 1, col: -1 },
  { row: 1, col: 1 },
];

function pathCells(start: Cell, dir: Cell, len: number): Cell[] {
  return Array.from({ length: len }, (_, i) => ({
    row: start.row + dir.row * i,
    col: start.col + dir.col * i,
  }));
}

/** Every in-bounds (start, direction) pair this word could occupy. */
function candidatesFor(word: string, size: number): { start: Cell; dir: Cell }[] {
  const out: { start: Cell; dir: Cell }[] = [];
  for (const dir of DIRECTIONS) {
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        const endRow = row + dir.row * (word.length - 1);
        const endCol = col + dir.col * (word.length - 1);
        if (endRow < 0 || endRow >= size || endCol < 0 || endCol >= size) continue;
        out.push({ start: { row, col }, dir });
      }
    }
  }
  return out;
}

/**
 * Try every shuffled placement until one crosses existing letters cleanly.
 * Writes the letters and returns the cells on success; returns null (and
 * writes nothing) when no placement anywhere on the grid works, which is the
 * caller's signal to drop the word.
 */
function tryPlace(grid: (string | null)[][], word: string, size: number): Cell[] | null {
  for (const { start, dir } of shuffle(candidatesFor(word, size))) {
    const cells = pathCells(start, dir, word.length);
    const fits = cells.every((cell, i) => {
      const existing = grid[cell.row][cell.col];
      return existing === null || existing === word[i];
    });
    if (!fits) continue;
    cells.forEach((cell, i) => {
      grid[cell.row][cell.col] = word[i];
    });
    return cells;
  }
  return null;
}

/** One weighted pool: every letter already on the grid appears extra times,
 *  plus a baseline of one so every letter stays possible. Filler drawn from
 *  it blends in rather than reading as obviously random. */
function fillPool(grid: (string | null)[][]): string[] {
  const freq: Record<string, number> = {};
  for (const row of grid) for (const ch of row) if (ch) freq[ch] = (freq[ch] ?? 0) + 1;
  const pool: string[] = [];
  for (let i = 0; i < 26; i++) {
    const ch = String.fromCharCode(97 + i);
    const weight = (freq[ch] ?? 0) + 1;
    for (let k = 0; k < weight; k++) pool.push(ch);
  }
  return pool;
}

function generatePuzzle(words: string[]): Puzzle {
  const longest = Math.max(...words.map((w) => w.length));
  const size = clamp(longest + 2, 10, 14);
  const grid: (string | null)[][] = Array.from({ length: size }, () =>
    Array<string | null>(size).fill(null),
  );

  // Shuffle first, then sort by length: the hardest (longest) words get first
  // pick of the empty grid, and ties are still in a random order each time.
  const ordered = shuffle(words).sort((a, b) => b.length - a.length);

  const placed: PlacedWord[] = [];
  for (const word of ordered) {
    const cells = tryPlace(grid, word, size);
    if (cells) placed.push({ word, cells });
  }

  const pool = fillPool(grid);
  const finalGrid = grid.map((row) => row.map((ch) => ch ?? pick(pool)));
  return { size, grid: finalGrid, placed };
}

/* ------------------------------------------------------------------ */
/* Selection geometry                                                  */
/* ------------------------------------------------------------------ */

const UNIT_DIRECTIONS = DIRECTIONS.map(({ row, col }) => {
  const len = Math.hypot(row, col);
  return { row: row / len, col: col / len };
});

/** The one of the eight directions whose unit vector best matches this
 *  offset, found by largest dot product rather than by angle, which sidesteps
 *  any wraparound edge case. */
function snapDirection(dRow: number, dCol: number): Cell {
  const len = Math.hypot(dRow, dCol) || 1;
  const nRow = dRow / len;
  const nCol = dCol / len;
  let best = 0;
  let bestDot = -Infinity;
  UNIT_DIRECTIONS.forEach((u, i) => {
    const dot = u.row * nRow + u.col * nCol;
    if (dot > bestDot) {
      bestDot = dot;
      best = i;
    }
  });
  return DIRECTIONS[best];
}

/** Snap an offset from `anchor` to the nearest straight line, then walk that
 *  line only as far as the offset actually projects, clamped to the grid. A
 *  sloppy drag (or an overshooting keyboard cursor) still selects cleanly. */
function buildPath(anchor: Cell, dRow: number, dCol: number, size: number): Cell[] {
  if (Math.hypot(dRow, dCol) < 0.5) return [anchor];
  const dir = snapDirection(dRow, dCol);
  const unitLenSq = dir.row * dir.row + dir.col * dir.col; // 1 axis, 2 diagonal
  let steps = Math.round((dRow * dir.row + dCol * dir.col) / unitLenSq);
  if (steps < 0) steps = 0;
  while (steps > 0) {
    const row = anchor.row + dir.row * steps;
    const col = anchor.col + dir.col * steps;
    if (row >= 0 && row < size && col >= 0 && col < size) break;
    steps--;
  }
  return Array.from({ length: steps + 1 }, (_, i) => ({
    row: anchor.row + dir.row * i,
    col: anchor.col + dir.col * i,
  }));
}

/** A path matches a placed word forwards or backwards: either direction of
 *  drag (or keyboard walk) counts as finding it. */
function pathMatches(path: Cell[], cells: Cell[]): boolean {
  if (path.length !== cells.length) return false;
  const n = cells.length;
  const forward = cells.every((cell, i) => cell.row === path[i].row && cell.col === path[i].col);
  if (forward) return true;
  return cells.every((cell, i) => cell.row === path[n - 1 - i].row && cell.col === path[n - 1 - i].col);
}

const cellKey = (row: number, col: number) => `${row}:${col}`;
/** Golden-angle spread so adjacent indices land on visually distinct hues. */
const hueFor = (i: number) => Math.round((i * 137.508) % 360);
/** Circular mean, so two lanes crossing at a cell blend to one steady hue
 *  instead of averaging straight through the 0/360 seam. */
function meanHue(hues: number[]): number {
  if (hues.length === 1) return hues[0];
  let sx = 0;
  let sy = 0;
  for (const h of hues) {
    const rad = (h * Math.PI) / 180;
    sx += Math.cos(rad);
    sy += Math.sin(rad);
  }
  const deg = (Math.atan2(sy, sx) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

const elapsedSecs = (startedAt: number | null) =>
  startedAt === null ? 0 : Math.floor((performance.now() - startedAt) / 1000);
const fmtTime = (secs: number) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;

/** The clock, isolated so a tick never touches the grid. */
function Timer({ startedAt, stopped }: { startedAt: number | null; stopped: number | null }) {
  const [secs, setSecs] = useState(0);
  const running = startedAt !== null && stopped === null;
  useGameLoop(running, 250, () => setSecs(elapsedSecs(startedAt)));
  useEffect(() => setSecs(0), [startedAt]);
  return <>{fmtTime(stopped ?? (startedAt === null ? 0 : secs))}</>;
}

/** The cell under a pointer event target, or null outside any cell. */
function cellAt(target: EventTarget | null): Cell | null {
  const el = (target as HTMLElement | null)?.closest?.("[data-row]") as HTMLElement | null;
  if (!el) return null;
  const row = Number(el.dataset.row);
  const col = Number(el.dataset.col);
  return Number.isFinite(row) && Number.isFinite(col) ? { row, col } : null;
}

export default function WordSearch({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);

  const seed = useSeed(runtime);
  const rawWords = seedArray<unknown>(seed, "words");
  const rawTopic = seedString(seed, "topic", "");

  const sanitized = useMemo(() => sanitizeWords(rawWords), [rawWords]);
  const finalWords = sanitized.length ? sanitized : FALLBACK_WORDS;
  const topicLabel = sanitized.length ? rawTopic || "Word Search" : FALLBACK_TOPIC;

  const [puzzle, setPuzzle] = useState<Puzzle | null>(null);
  const [foundSet, setFoundSet] = useState<Set<string>>(() => new Set());
  const [cursor, setCursor] = useState<Cell>({ row: 0, col: 0 });
  const [anchor, setAnchor] = useState<Cell | null>(null);
  const [dragPath, setDragPath] = useState<Cell[] | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [endSecs, setEndSecs] = useState<number | null>(null);

  const dragRef = useRef<{ anchor: Cell; rect: DOMRect } | null>(null);
  const dragPathRef = useRef<Cell[] | null>(null);

  const regenerate = useCallback((words: string[]) => {
    const built = generatePuzzle(words);
    setPuzzle(built);
    setFoundSet(new Set());
    setCursor({ row: Math.floor(built.size / 2), col: Math.floor(built.size / 2) });
    setAnchor(null);
    dragRef.current = null;
    dragPathRef.current = null;
    setDragPath(null);
    setStartedAt(performance.now());
    setEndSecs(null);
  }, []);

  // Generation uses randomness, so it happens here rather than in a useState
  // initialiser. `finalWords` only changes reference when the seed actually
  // delivers a new list, so this does not re-fire on every render.
  useEffect(() => {
    regenerate(finalWords);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finalWords, regenerate]);

  const tryConfirm = useCallback(
    (path: Cell[]) => {
      if (!puzzle) return;
      const hit = puzzle.placed.find((w) => !foundSet.has(w.word) && pathMatches(path, w.cells));
      if (hit) setFoundSet((prev) => new Set(prev).add(hit.word));
    },
    [puzzle, foundSet],
  );

  /* ---- Pointer input: one path for mouse, touch and pen ---- */

  const onPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      if (!puzzle) return;
      const cell = cellAt(e.target);
      if (!cell) return;
      const rect = e.currentTarget.getBoundingClientRect();
      dragRef.current = { anchor: cell, rect };
      dragPathRef.current = [cell];
      setDragPath([cell]);
      setAnchor(null); // a pointer drag supersedes any keyboard anchor in progress
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    [puzzle],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || !puzzle) return;
      const cellW = drag.rect.width / puzzle.size;
      const cellH = drag.rect.height / puzzle.size;
      const anchorCx = drag.rect.left + (drag.anchor.col + 0.5) * cellW;
      const anchorCy = drag.rect.top + (drag.anchor.row + 0.5) * cellH;
      const path = buildPath(
        drag.anchor,
        (e.clientY - anchorCy) / cellH,
        (e.clientX - anchorCx) / cellW,
        puzzle.size,
      );
      dragPathRef.current = path;
      setDragPath(path);
    },
    [puzzle],
  );

  const endDrag = useCallback(() => {
    const path = dragPathRef.current;
    dragRef.current = null;
    dragPathRef.current = null;
    setDragPath(null);
    if (path && path.length > 1) tryConfirm(path);
  }, [tryConfirm]);

  /* ---- Keyboard: arrows move a cursor, Enter anchors then confirms ---- */

  const moveCursor = useCallback(
    (d: Direction) => {
      if (!puzzle) return;
      setCursor((c) => ({
        row: clamp(c.row + (d === "up" ? -1 : d === "down" ? 1 : 0), 0, puzzle.size - 1),
        col: clamp(c.col + (d === "left" ? -1 : d === "right" ? 1 : 0), 0, puzzle.size - 1),
      }));
    },
    [puzzle],
  );
  useDirectionKeys(moveCursor);

  useKeys({
    enter: () => {
      if (!puzzle || !gridRef.current?.contains(document.activeElement)) return;
      if (!anchor) {
        setAnchor(cursor);
        return;
      }
      const path = buildPath(anchor, cursor.row - anchor.row, cursor.col - anchor.col, puzzle.size);
      setAnchor(null);
      if (path.length > 1) tryConfirm(path);
    },
    escape: () => setAnchor(null),
  });

  // Roving tabindex: the cursor drags DOM focus along with it, but only while
  // the grid already holds focus, so arrowing around never yanks focus off
  // whatever control the player was actually using.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !grid.contains(document.activeElement)) return;
    grid.querySelector<HTMLElement>(`[data-row="${cursor.row}"][data-col="${cursor.col}"]`)?.focus();
  }, [cursor]);

  /* ---- Derived state ---- */

  const kbPath = anchor && puzzle ? buildPath(anchor, cursor.row - anchor.row, cursor.col - anchor.col, puzzle.size) : null;
  const currentPath = dragPath ?? kbPath;
  const selectingKeys = new Set((currentPath ?? []).map((c) => cellKey(c.row, c.col)));

  const foundMap = new Map<string, number[]>();
  if (puzzle) {
    puzzle.placed.forEach((w, i) => {
      if (!foundSet.has(w.word)) return;
      const hue = hueFor(i);
      for (const cell of w.cells) {
        const k = cellKey(cell.row, cell.col);
        const arr = foundMap.get(k);
        if (arr) arr.push(hue);
        else foundMap.set(k, [hue]);
      }
    });
  }

  const total = puzzle?.placed.length ?? 0;
  const found = foundSet.size;
  const allFound = total > 0 && found === total;
  const status: GameStatus = !puzzle ? "ready" : allFound ? "won" : "playing";

  useEffect(() => {
    if (allFound && endSecs === null && startedAt !== null) setEndSecs(elapsedSecs(startedAt));
  }, [allFound, endSecs, startedAt]);

  useGameOverReport(
    runtime,
    status === "won",
    () => `Word Search finished: found ${found} of ${total} words about ${topicLabel} in ${fmtTime(endSecs ?? 0)}.`,
  );

  const [shareStatus, share] = useShare(runtime);
  const askNewTheme = useCallback(() => {
    void share(
      "I finished that word search! Give me a new themed word search to play.",
      `Word Search finished: found ${found}/${total} words about ${topicLabel} in ${fmtTime(endSecs ?? 0)}.`,
    );
  }, [share, found, total, topicLabel, endSecs]);

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={isFull ? s.fullFrame : ""}>
      <GameHeader
        title="Word Search"
        icon={
          <span aria-hidden="true">🔎</span>
        }
        hint={topicLabel}
        stats={[
          { label: "Found", value: `${found} / ${total}` },
          { label: "Time", value: <Timer startedAt={startedAt} stopped={endSecs} /> },
        ]}
      />

      <div className={s.boardWrap}>
        <div
          ref={gridRef}
          className={s.board}
          role="grid"
          aria-label={puzzle ? `Word search grid, ${puzzle.size} by ${puzzle.size}` : "Word search grid"}
          aria-rowcount={puzzle?.size}
          aria-colcount={puzzle?.size}
          style={sv({ "--size": puzzle?.size ?? 10 })}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={endDrag}
        >
          {puzzle &&
            Array.from({ length: puzzle.size }, (_, row) => (
              <div key={row} className={s.row} role="row">
                {Array.from({ length: puzzle.size }, (_, col) => {
                  const letter = puzzle.grid[row][col];
                  const hues = foundMap.get(cellKey(row, col));
                  const isFoundCell = Boolean(hues && hues.length);
                  const isSelecting = selectingKeys.has(cellKey(row, col));
                  const isCursor = cursor.row === row && cursor.col === col;
                  const isAnchor = anchor !== null && anchor.row === row && anchor.col === col;
                  return (
                    <div
                      key={col}
                      role="gridcell"
                      data-row={row}
                      data-col={col}
                      tabIndex={isCursor ? 0 : -1}
                      aria-selected={isSelecting || undefined}
                      aria-label={`row ${row + 1} column ${col + 1}, ${letter}${isFoundCell ? ", part of a found word" : ""}`}
                      className={[
                        s.cell,
                        isSelecting ? s.selecting : "",
                        isFoundCell ? s.found : "",
                        isCursor ? s.cursor : "",
                        isAnchor ? s.anchored : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={isFoundCell ? sv({ "--hue": meanHue(hues!) }) : undefined}
                    >
                      {letter}
                    </div>
                  );
                })}
              </div>
            ))}
        </div>

        <Overlay
          status={status}
          detail={status === "won" ? `Found all ${total} words in ${fmtTime(endSecs ?? 0)}.` : undefined}
          action={status === "won" ? "New theme" : undefined}
          onAction={status === "won" ? askNewTheme : undefined}
        />
      </div>

      <ul className={s.wordList} aria-label="Words to find">
        {puzzle?.placed.map((w, i) => {
          const isWordFound = foundSet.has(w.word);
          return (
            <li
              key={w.word}
              className={[s.wordChip, isWordFound ? s.wordFound : ""].filter(Boolean).join(" ")}
              style={isWordFound ? sv({ "--hue": hueFor(i) }) : undefined}
            >
              {w.word}
            </li>
          );
        })}
      </ul>

      <Notice>
        Drag across letters to select. Or press Enter to anchor a cell, arrows to extend, Enter to
        confirm.
      </Notice>

      <StandardControls
        status={status}
        onRestart={() => regenerate(finalWords)}
      />
      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
