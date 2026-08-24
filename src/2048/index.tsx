/**
 * @file 2048, built around tile identity so nothing ever teleports.
 *
 * The merge rules are the easy half. What makes a 2048 feel right is the
 * motion, so identity is the centre of the design: every tile carries an `id`
 * that survives a move, and the node keyed by that id only ever changes its
 * `--r` and `--c` custom properties. The browser CSS-transitions the
 * `transform` on an outer slot, while an inner face element owns the pop and
 * appear animations, so sliding and scaling never fight over one property.
 *
 * A merge produces three tiles, not one: both sources keep their identity and
 * slide onto the destination marked `absorbed`, then a brand new tile with the
 * doubled value pops in on top once the slide has landed. Absorbed tiles are
 * dropped at the start of the next move rather than on a timer, which keeps the
 * whole animation declarative, and giving every merge a fresh id is what
 * guarantees the pop keyframes restart when one square merges twice in a row.
 *
 * The opening board is fixed (two tiles on the diagonal) because StrictMode
 * double-invokes state initialisers. Randomness starts on the first move.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ControlBar,
  DPad,
  GameFrame,
  GameHeader,
  Overlay,
  StatusLine,
  isTerminal,
  seedNumber,
  sv,
  useBest,
  useDirectionKeys,
  useFullscreen,
  useGameOverReport,
  useKeys,
  useSeed,
  useShare,
  useSwipe,
  type Direction,
  type GameStatus,
} from "../lib/game";
import { randInt } from "../lib/rng";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./game2048.module.css";

/**
 * The classic warm ramp, and the one place a literal colour belongs: on a 2048
 * board the colour is the content. `ink` is picked per value rather than per
 * theme, dark on the pale creams and yellows, light on the saturated oranges,
 * so every tile stays legible whichever way the host is themed. The oranges sit
 * a shade deeper than the original palette so white on them actually reads.
 */
const TILE_RAMP: Record<number, { bg: string; ink: string }> = {
  2: { bg: "#eee4da", ink: "#63594b" },
  4: { bg: "#ede0c8", ink: "#63594b" },
  8: { bg: "#d47b3a", ink: "#ffffff" },
  16: { bg: "#d1662f", ink: "#ffffff" },
  32: { bg: "#cd4f2c", ink: "#ffffff" },
  64: { bg: "#c53a24", ink: "#ffffff" },
  128: { bg: "#edcf72", ink: "#4c3d10" },
  256: { bg: "#edc95c", ink: "#4c3d10" },
  512: { bg: "#edc44a", ink: "#4c3d10" },
  1024: { bg: "#e8bb33", ink: "#43350c" },
  2048: { bg: "#e5b422", ink: "#43350c" },
};
/** Past 2048 the ramp would run out, so everything above shares one slate. */
const TILE_SUPER = { bg: "#3c3a32", ink: "#f9f6f2" };
const rampFor = (v: number) => TILE_RAMP[v] ?? TILE_SUPER;

/** Font size as a fraction of a cell, so five digits still fit the tile. */
const scaleFor = (v: number) => (v < 100 ? 0.46 : v < 1000 ? 0.38 : v < 10000 ? 0.3 : 0.24);

const TARGET = 2048;

interface Tile {
  id: number;
  r: number;
  c: number;
  value: number;
  /** Produced by a merge this move: pops in once the slide lands. */
  merged?: boolean;
  /** Placed by the spawner this move: fades and scales in. */
  spawned?: boolean;
  /** Eaten by a merge: slides to the destination, then fades under it. */
  absorbed?: boolean;
}

interface Game {
  size: number;
  tiles: Tile[];
  nextId: number;
  score: number;
  moves: number;
  status: GameStatus;
  /** Set once the player chooses to play on past 2048. */
  keepGoing: boolean;
}

/** The tiles that actually occupy the grid, ignoring last move's leftovers. */
const living = (tiles: Tile[]) => tiles.filter((t) => !t.absorbed);

const highest = (tiles: Tile[]) => living(tiles).reduce((m, t) => (t.value > m ? t.value : m), 0);

/**
 * A fresh board. Fixed positions, no randomness: StrictMode runs initialisers
 * twice and a random opening would differ between the two passes. Ids continue
 * from the previous game so React always builds new nodes and the two tiles
 * animate in on a restart.
 */
function newGame(size: number, startId = 1): Game {
  const mid = Math.floor((size - 1) / 2);
  return {
    size,
    tiles: [
      { id: startId, r: mid, c: mid, value: 2, spawned: true },
      { id: startId + 1, r: mid + 1, c: mid + 1, value: 2, spawned: true },
    ],
    nextId: startId + 2,
    score: 0,
    moves: 0,
    status: "playing",
    keepGoing: false,
  };
}

/** Values by cell index, zero for empty. Absorbed tiles are not on the board. */
function occupancy(tiles: Tile[], size: number): number[] {
  const grid = new Array<number>(size * size).fill(0);
  for (const t of tiles) if (!t.absorbed) grid[t.r * size + t.c] = t.value;
  return grid;
}

/** A 2 or a 4 (90/10) in a random empty cell, or null when the board is full. */
function spawnTile(tiles: Tile[], size: number, id: number): Tile | null {
  const grid = occupancy(tiles, size);
  const free: number[] = [];
  for (let i = 0; i < grid.length; i++) if (grid[i] === 0) free.push(i);
  if (free.length === 0) return null;
  const cell = free[randInt(0, free.length - 1)];
  return {
    id,
    r: Math.floor(cell / size),
    c: cell % size,
    value: randInt(1, 10) === 1 ? 4 : 2,
    spawned: true,
  };
}

/** Any empty cell, or any equal neighbour, means a move is still available. */
function hasMove(tiles: Tile[], size: number): boolean {
  const grid = occupancy(tiles, size);
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const v = grid[r * size + c];
      if (v === 0) return true;
      if (c + 1 < size && grid[r * size + c + 1] === v) return true;
      if (r + 1 < size && grid[(r + 1) * size + c] === v) return true;
    }
  }
  return false;
}

/**
 * One move. Returns the same object when nothing shifted, which is how a dead
 * move avoids spawning a tile.
 */
function slide(g: Game, dir: Direction): Game {
  const size = g.size;
  // Rebuilding from scratch drops last move's absorbed tiles and clears the
  // animation flags, so a flag coming back on is a real class change.
  const grid = new Array<Tile | null>(size * size).fill(null);
  for (const t of g.tiles) {
    if (t.absorbed) continue;
    grid[t.r * size + t.c] = { id: t.id, r: t.r, c: t.c, value: t.value };
  }

  const horizontal = dir === "left" || dir === "right";
  const leading = dir === "left" || dir === "up";
  const out: Tile[] = [];
  let nextId = g.nextId;
  let score = g.score;
  let moved = false;
  let reachedTarget = false;

  for (let line = 0; line < size; line++) {
    // This row or column, ordered from the edge the tiles travel into.
    const seq: Tile[] = [];
    for (let i = 0; i < size; i++) {
      const k = leading ? i : size - 1 - i;
      const t = horizontal ? grid[line * size + k] : grid[k * size + line];
      if (t) seq.push(t);
    }
    // Walking from that edge is what makes merges resolve from the direction of
    // travel, and consuming two entries at a time is what stops one tile
    // merging twice in a single move.
    for (let i = 0, slot = 0; i < seq.length; slot++) {
      const at = leading ? slot : size - 1 - slot;
      const r = horizontal ? line : at;
      const c = horizontal ? at : line;
      const a = seq[i];
      const b = seq[i + 1];
      if (b && b.value === a.value) {
        const value = a.value * 2;
        out.push({ ...a, r, c, absorbed: true });
        out.push({ ...b, r, c, absorbed: true });
        out.push({ id: nextId++, r, c, value, merged: true });
        score += value;
        if (value === TARGET) reachedTarget = true;
        moved = true;
        i += 2;
      } else {
        if (a.r !== r || a.c !== c) moved = true;
        out.push({ ...a, r, c });
        i += 1;
      }
    }
  }

  if (!moved) return g;

  const fresh = spawnTile(out, size, nextId);
  if (fresh) {
    out.push(fresh);
    nextId++;
  }

  const status: GameStatus =
    reachedTarget && !g.keepGoing ? "won" : hasMove(out, size) ? "playing" : "over";
  return { ...g, tiles: out, nextId, score, moves: g.moves + 1, status };
}

/** One step of undo: the board as it stood before the last move. */
const snapshot = (g: Game): Game => ({
  ...g,
  tiles: living(g.tiles).map((t) => ({ id: t.id, r: t.r, c: t.c, value: t.value })),
});

export default function Game2048({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const seed = useSeed(runtime);
  const size = seedNumber(seed, "size", 4, 3, 6);

  const [game, setGame] = useState<Game>(() => newGame(4));
  const gameRef = useRef(game); // authoritative, so two fast keys cannot race
  const undoRef = useRef<Game | null>(null);
  const [canUndo, setCanUndo] = useState(false);

  const commit = useCallback((next: Game) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  const reset = useCallback(
    (boardSize: number) => {
      undoRef.current = null;
      setCanUndo(false);
      commit(newGame(boardSize, gameRef.current.nextId));
    },
    [commit],
  );

  // The seed lands after mount, so the default 4x4 is replaced when it arrives.
  useEffect(() => {
    if (gameRef.current.size !== size) reset(size);
  }, [size, reset]);

  const move = useCallback(
    (dir: Direction) => {
      const g = gameRef.current;
      if (g.status !== "playing") return;
      const next = slide(g, dir);
      if (next === g) return;
      undoRef.current = snapshot(g);
      setCanUndo(true);
      commit(next);
    },
    [commit],
  );

  const undo = useCallback(() => {
    const prev = undoRef.current;
    if (!prev) return;
    undoRef.current = null;
    setCanUndo(false);
    // Ids keep climbing, so the restored tiles reuse their live nodes and glide
    // back while the merged and spawned tiles simply unmount.
    commit({ ...prev, nextId: gameRef.current.nextId });
  }, [commit]);

  const playOn = useCallback(() => {
    const g = gameRef.current;
    commit({ ...g, keepGoing: true, status: hasMove(g.tiles, g.size) ? "playing" : "over" });
  }, [commit]);

  useDirectionKeys(move);
  useKeys({ z: undo });
  const swipe = useSwipe(move);

  const best = useBest(game.score);
  const top = highest(game.tiles);
  const won = game.status === "won";

  useGameOverReport(runtime, isTerminal(game.status), () =>
    won
      ? `2048 reached on a ${game.size} by ${game.size} board. Score ${game.score} in ${game.moves} moves.`
      : `2048 over. Score ${game.score}, best tile ${top}, ${game.moves} moves on a ${game.size} by ${game.size} board.`,
  );

  const [shareStatus, share] = useShare(runtime);
  const tell = useCallback(() => {
    void share(
      `I scored ${game.score} in 2048 with a ${top} tile!`,
      `2048 result: score ${game.score}, best tile ${top}, ${game.moves} moves.`,
    );
  }, [share, game.score, game.moves, top]);

  // Sorted by id so the DOM order only ever gains at the end and loses in the
  // middle. React then never has to move a node, which would kill a running
  // transition.
  const tiles = [...game.tiles].sort((a, b) => a.id - b.id);

  return (
    <GameFrame
      runtime={runtime}
      innerRef={rootRef}
      fullscreen={isFull}
      wide
      className={isFull ? s.fullBoard : ""}
    >
      <GameHeader
        title="2048"
        stats={[
          { label: "Score", value: game.score },
          { label: "Best", value: best },
        ]}
        hint="Arrows, WASD or swipe to slide"
      />

      <div className={s.boardWrap}>
        <div
          className={s.board}
          style={sv({ "--grid": game.size })}
          role="img"
          aria-label={`2048 board, ${game.size} by ${game.size}. Highest tile ${top}, score ${game.score}.`}
          {...swipe}
        >
          {/* Keyed by size so a seeded resize rebuilds the grid rather than
              sliding the old tiles into new cells. */}
          <div className={s.pad} key={game.size}>
            {Array.from({ length: game.size * game.size }, (_, i) => (
              <div
                key={`hole${i}`}
                className={s.slot}
                style={sv({ "--r": Math.floor(i / game.size), "--c": i % game.size })}
              >
                <div className={s.hole} />
              </div>
            ))}

            {tiles.map((t) => {
              const { bg, ink } = rampFor(t.value);
              return (
                <div
                  key={t.id}
                  className={`${s.slot} ${t.absorbed ? s.under : ""} ${t.merged ? s.over : ""}`}
                  style={sv({ "--r": t.r, "--c": t.c })}
                >
                  <div
                    className={`${s.tile} ${t.absorbed ? s.ghost : ""} ${t.merged ? s.pop : ""} ${
                      t.spawned ? s.appear : ""
                    } ${t.value >= 1024 ? s.milestone : ""}`}
                    style={sv({ "--bg": bg, "--ink": ink, "--fs": scaleFor(t.value) })}
                  >
                    {t.value}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <Overlay
          status={game.status}
          detail={
            won
              ? `Score ${game.score}. Play on for a bigger tile.`
              : `Score ${game.score}, best tile ${top}`
          }
          action={won ? "Keep going" : "Play again"}
          onAction={won ? playOn : () => reset(game.size)}
          secondary={won ? "New game" : canUndo ? "Undo" : undefined}
          onSecondary={won ? () => reset(game.size) : canUndo ? undo : undefined}
        />
      </div>

      <DPad onDirection={move} />

      <ControlBar>
        <button
          className={`${ui.btn} ${ui.primary}`}
          onClick={undo}
          disabled={!canUndo}
          title="Undo the last move (Z)"
        >
          Undo
        </button>
        <button className={ui.btn} onClick={() => reset(game.size)}>
          New game
        </button>
        <button className={ui.btn} onClick={toggleFull}>
          {isFull ? "Exit fullscreen" : "Fullscreen"}
        </button>
        <button className={ui.btn} onClick={tell} disabled={!isTerminal(game.status)}>
          Tell the model
        </button>
      </ControlBar>

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
