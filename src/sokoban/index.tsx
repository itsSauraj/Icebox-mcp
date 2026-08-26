/**
 * @file Sokoban: push every crate onto a target.
 *
 * Fully deterministic, no randomness anywhere, so the value is entirely in the
 * level design and the feel of a move. Levels are string art in the standard
 * notation, parsed once on load.
 *
 * Two things make or break a Sokoban:
 *
 *  - **Undo must be unlimited.** One wrong push can dead-end a level, and a
 *    game that answers that with "restart" is a game people stop playing. The
 *    move stack holds full positions, which for a board this size is cheaper
 *    than reconstructing deltas.
 *  - **Deadlocks must be announced.** A crate wedged into a corner of two
 *    walls can never move again, and discovering that ten moves later is the
 *    worst experience the genre offers. It is said quietly and undo is
 *    suggested; the player is never forced to restart.
 *
 * The player and any pushed crate slide between cells rather than teleporting,
 * using the same technique as Snake: position by transform, let the browser
 * tween. That slide is what makes a push feel physical.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlBar,
  DPad,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  StatusLine,
  isTerminal,
  sv,
  useDirectionKeys,
  useFullscreen,
  useGameOverReport,
  useKeys,
  useShare,
  useSwipe,
  type Direction,
  type GameStatus,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./sokoban.module.css";

/**
 * Standard Sokoban notation:
 *   `#` wall   `@` player   `$` crate   `.` target
 *   `*` crate on target     `+` player on target    space floor
 *
 * Ordered by real difficulty. The first three teach the mechanic: push, then
 * that a corner kills a crate, then that order matters. The last few need
 * genuine planning.
 */
interface LevelDef {
  name: string;
  par: number;
  rows: string[];
}

const LEVELS: LevelDef[] = [
  {
    name: "First push",
    par: 1,
    rows: [
      "#######",
      "#     #",
      "# @$. #",
      "#     #",
      "#######",
    ],
  },
  {
    name: "Mind the corner",
    par: 10,
    rows: [
      "########",
      "#      #",
      "#  $   #",
      "# @$.. #",
      "#      #",
      "########",
    ],
  },
  {
    name: "Order matters",
    par: 14,
    rows: [
      "########",
      "#.     #",
      "# $$   #",
      "# @    #",
      "#.     #",
      "########",
    ],
  },
  {
    name: "The corridor",
    par: 23,
    rows: [
      "#########",
      "#. #    #",
      "#  $ $  #",
      "#.  @   #",
      "#########",
    ],
  },
  {
    name: "Two rooms",
    par: 21,
    rows: [
      "##########",
      "#..  #   #",
      "#  $ $   #",
      "#  @     #",
      "#    #   #",
      "##########",
    ],
  },
  {
    name: "Around the pillar",
    par: 10,
    rows: [
      "#########",
      "#       #",
      "#  ...  #",
      "#  $$$  #",
      "#   @   #",
      "#       #",
      "#########",
    ],
  },
  {
    name: "Tight fit",
    par: 36,
    rows: [
      "########",
      "#..    #",
      "#..$$  #",
      "#   @  #",
      "#  $$  #",
      "#      #",
      "########",
    ],
  },
  {
    name: "The hook",
    par: 16,
    rows: [
      "##########",
      "#   @    #",
      "#  $$$   #",
      "#        #",
      "#  ...   #",
      "##########",
    ],
  },
  {
    name: "Crossroads",
    par: 29,
    rows: [
      "#########",
      "#   .   #",
      "#  $$$  #",
      "#. @  . #",
      "#  $ $  #",
      "#   ..  #",
      "#########",
    ],
  },
  {
    name: "The vault",
    par: 39,
    rows: [
      "##########",
      "#....    #",
      "#        #",
      "#  $$$$  #",
      "#   @    #",
      "#        #",
      "##########",
    ],
  },
  {
    name: "Split lift",
    par: 25,
    rows: [
      "##########",
      "#        #",
      "# .. ..  #",
      "#   #    #",
      "# $$ $$  #",
      "#   @    #",
      "##########",
    ],
  },
  {
    name: "Last word",
    par: 36,
    rows: [
      "##########",
      "#  .  .  #",
      "# $ ## $ #",
      "#   @    #",
      "# $ ## $ #",
      "#  .  .  #",
      "##########",
    ],
  },
];

interface Pos {
  r: number;
  c: number;
}

interface Level {
  name: string;
  par: number;
  rows: number;
  cols: number;
  walls: boolean[][];
  targets: boolean[][];
  targetCount: number;
}

interface Position {
  player: Pos;
  crates: Pos[];
}

const DELTA: Record<Direction, Pos> = {
  up: { r: -1, c: 0 },
  down: { r: 1, c: 0 },
  left: { r: 0, c: -1 },
  right: { r: 0, c: 1 },
};

/** Parse the notation into a static level plus its starting position. */
function parseLevel(def: LevelDef): { level: Level; start: Position } {
  const rows = def.rows.length;
  const cols = Math.max(...def.rows.map((r) => r.length));
  const walls: boolean[][] = [];
  const targets: boolean[][] = [];
  const crates: Pos[] = [];
  let player: Pos = { r: 0, c: 0 };

  for (let r = 0; r < rows; r++) {
    walls.push(new Array(cols).fill(false));
    targets.push(new Array(cols).fill(false));
    for (let c = 0; c < cols; c++) {
      const ch = def.rows[r][c] ?? " ";
      if (ch === "#") walls[r][c] = true;
      if (ch === "." || ch === "*" || ch === "+") targets[r][c] = true;
      if (ch === "$" || ch === "*") crates.push({ r, c });
      if (ch === "@" || ch === "+") player = { r, c };
    }
  }

  const targetCount = targets.flat().filter(Boolean).length;
  // A typo in the level data should be caught here, not shipped.
  if (targetCount !== crates.length) {
    console.warn(`Sokoban level "${def.name}": ${crates.length} crates but ${targetCount} targets.`);
  }

  return {
    level: { name: def.name, par: def.par, rows, cols, walls, targets, targetCount },
    start: { player, crates },
  };
}

const PARSED = LEVELS.map(parseLevel);

const samePos = (a: Pos, b: Pos) => a.r === b.r && a.c === b.c;
const crateAt = (crates: Pos[], p: Pos) => crates.findIndex((c) => samePos(c, p));

/** Result of attempting a move, or null when it is blocked. */
function step(level: Level, pos: Position, dir: Direction): { next: Position; pushed: boolean } | null {
  const d = DELTA[dir];
  const to = { r: pos.player.r + d.r, c: pos.player.c + d.c };
  if (to.r < 0 || to.r >= level.rows || to.c < 0 || to.c >= level.cols) return null;
  if (level.walls[to.r][to.c]) return null;

  const idx = crateAt(pos.crates, to);
  if (idx === -1) return { next: { player: to, crates: pos.crates }, pushed: false };

  // A crate moves only into empty floor. Crates are never pulled.
  const beyond = { r: to.r + d.r, c: to.c + d.c };
  if (beyond.r < 0 || beyond.r >= level.rows || beyond.c < 0 || beyond.c >= level.cols) return null;
  if (level.walls[beyond.r][beyond.c]) return null;
  if (crateAt(pos.crates, beyond) !== -1) return null;

  const crates = pos.crates.slice();
  crates[idx] = beyond;
  return { next: { player: to, crates }, pushed: true };
}

const solved = (level: Level, pos: Position) => pos.crates.every((c) => level.targets[c.r][c.c]);

/**
 * The simple deadlock: a crate off-target wedged into a corner of two walls
 * can never move again. Detecting the general case is expensive and this one
 * accounts for almost every accidental soft-lock.
 */
function stuckCrate(level: Level, pos: Position): Pos | null {
  for (const crate of pos.crates) {
    if (level.targets[crate.r][crate.c]) continue;
    const up = crate.r === 0 || level.walls[crate.r - 1][crate.c];
    const down = crate.r === level.rows - 1 || level.walls[crate.r + 1][crate.c];
    const left = crate.c === 0 || level.walls[crate.r][crate.c - 1];
    const right = crate.c === level.cols - 1 || level.walls[crate.r][crate.c + 1];
    if ((up || down) && (left || right)) return crate;
  }
  return null;
}

export default function Sokoban({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);

  const [levelIndex, setLevelIndex] = useState(0);
  const { level, start } = PARSED[levelIndex];

  const [pos, setPos] = useState<Position>(start);
  const [history, setHistory] = useState<Position[]>([]);
  const [moves, setMoves] = useState(0);
  const [pushes, setPushes] = useState(0);
  const [cleared, setCleared] = useState<Set<number>>(() => new Set());
  const [picker, setPicker] = useState(false);

  const won = solved(level, pos);
  const status: GameStatus = won ? "won" : "playing";
  const stuck = useMemo(() => (won ? null : stuckCrate(level, pos)), [level, pos, won]);

  const loadLevel = useCallback((i: number) => {
    setLevelIndex(i);
    setPos(PARSED[i].start);
    setHistory([]);
    setMoves(0);
    setPushes(0);
    setPicker(false);
  }, []);

  const restart = useCallback(() => loadLevel(levelIndex), [loadLevel, levelIndex]);

  const move = useCallback(
    (dir: Direction) => {
      if (won) return;
      const result = step(level, pos, dir);
      if (!result) return;
      setHistory((h) => [...h, pos]);
      setPos(result.next);
      setMoves((n) => n + 1);
      if (result.pushed) setPushes((n) => n + 1);
    },
    [won, level, pos],
  );

  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setPos(h[h.length - 1]);
      setMoves((n) => Math.max(0, n - 1));
      return h.slice(0, -1);
    });
  }, []);

  useDirectionKeys(move, undefined, !won);
  useKeys({ z: undo, u: undo, r: restart });
  const swipe = useSwipe(move);

  useEffect(() => {
    if (!won) return;
    setCleared((prev) => (prev.has(levelIndex) ? prev : new Set(prev).add(levelIndex)));
  }, [won, levelIndex]);

  useGameOverReport(runtime, won, () =>
    `Sokoban level ${levelIndex + 1} "${level.name}" solved in ${moves} moves (par ${level.par}), ${pushes} pushes.`,
  );

  const tell = useCallback(() => {
    void share(
      `Cleared Sokoban level ${levelIndex + 1} in ${moves} moves against a par of ${level.par}.`,
      `Sokoban: ${cleared.size} of ${LEVELS.length} levels cleared.`,
    );
  }, [share, levelIndex, moves, level.par, cleared.size]);

  const nextLevel = useCallback(() => {
    if (levelIndex + 1 < LEVELS.length) loadLevel(levelIndex + 1);
  }, [levelIndex, loadLevel]);

  const onTarget = pos.crates.filter((c) => level.targets[c.r][c.c]).length;
  const lastLevel = levelIndex + 1 >= LEVELS.length;

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Sokoban"
        stats={[
          { label: "Level", value: `${levelIndex + 1}/${LEVELS.length}` },
          { label: "Moves", value: moves },
          { label: "Par", value: level.par },
          { label: "Crates", value: `${onTarget}/${level.targetCount}` },
        ]}
        hint={level.name}
      />

      {/* The level dimensions live on the wrapper, not the board. The wrapper
          sizes itself from them, and custom properties only inherit downward,
          so setting them on the board left the wrapper with an invalid width
          calc and collapsed the whole thing to nothing. The board reads the
          same two values by inheritance. */}
      <div className={s.boardWrap} style={sv({ "--cols": level.cols, "--rows": level.rows })}>
        <div
          className={s.board}
          role="img"
          aria-label={`Sokoban level ${levelIndex + 1}, ${onTarget} of ${level.targetCount} crates placed`}
          {...swipe}
        >
          {level.walls.map((row, r) =>
            row.map((wall, c) => (
              <div
                key={`${r}-${c}`}
                className={`${s.tile} ${wall ? s.wall : s.floor} ${level.targets[r][c] ? s.target : ""}`}
                style={sv({ "--r": r, "--c": c })}
              />
            )),
          )}

          {/* Crates and the player are positioned by transform so they glide
              between cells rather than jumping. */}
          {pos.crates.map((crate, i) => (
            <div
              key={i}
              className={`${s.crate} ${level.targets[crate.r][crate.c] ? s.crateHome : ""} ${
                stuck && samePos(stuck, crate) ? s.crateStuck : ""
              }`}
              style={sv({ "--r": crate.r, "--c": crate.c })}
            />
          ))}

          <div className={s.player} style={sv({ "--r": pos.player.r, "--c": pos.player.c })} />
        </div>

        <Overlay
          status={status}
          title={lastLevel ? "All levels cleared" : "Level cleared"}
          detail={`${moves} moves against a par of ${level.par}.${moves <= level.par ? " Under par." : ""}`}
          action={lastLevel ? "Play again" : "Next level"}
          onAction={lastLevel ? () => loadLevel(0) : nextLevel}
          secondary="Retry"
          onSecondary={restart}
        />
      </div>

      <DPad onDirection={move} />

      <ControlBar>
        <button className={`${ui.btn} ${ui.primary}`} onClick={undo} disabled={history.length === 0}>
          Undo
        </button>
        <button className={ui.btn} onClick={restart}>
          Restart
        </button>
        <button className={ui.btn} onClick={() => setPicker((v) => !v)} aria-pressed={picker}>
          Levels
        </button>
        <button className={ui.btn} onClick={tell} disabled={!isTerminal(status)}>
          Tell the model
        </button>
      </ControlBar>

      {picker && (
        <div className={s.picker} role="group" aria-label="Levels">
          {LEVELS.map((l, i) => (
            <button
              key={l.name}
              className={`${s.pick} ${i === levelIndex ? s.pickCurrent : ""} ${cleared.has(i) ? s.pickDone : ""}`}
              onClick={() => loadLevel(i)}
              aria-current={i === levelIndex}
              aria-label={`Level ${i + 1}, ${l.name}${cleared.has(i) ? ", cleared" : ""}`}
            >
              {i + 1}
            </button>
          ))}
        </div>
      )}

      {stuck && (
        <Notice>
          That crate is stuck in a corner and can never move again. Undo to get it back.
        </Notice>
      )}

      <p className={ui.status} role="status" aria-live="polite">
        {shareStatus || (won ? `Level cleared in ${moves} moves.` : "")}
      </p>

      <StatusLine>{null}</StatusLine>
    </GameFrame>
  );
}
