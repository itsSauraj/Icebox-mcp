/**
 * @file Stack Tower: one tap, an endless narrowing tower.
 *
 * A block slides back and forth above the stack; tapping drops it. Whatever
 * doesn't land on the block below is sliced off, and the sliced overlap
 * becomes the new top of the tower, narrower than before. Missing entirely
 * ends the run.
 *
 * Coordinates are virtual, not pixels: horizontal position and width live on
 * a fixed 0..VW scale (`VW`), scaled to the board with plain percentages, so
 * the slide (`useFrameLoop`, integrated against `dtMs`) never has to know how
 * many real pixels wide the board is. Vertical position is row-based: each
 * block is one row tall, and the whole stack sits inside a `.world` div that
 * is translated down by one `transform` as the tower grows, so the block
 * that was just placed always lands at the same screen height. That single
 * transform, animated in CSS, is the "camera".
 *
 * The falling block itself never animates its horizontal position: the slice
 * is resolved the instant the player taps (their tap, their timing), so the
 * landed block is rendered immediately at its final, trimmed left/width, and
 * only plays a fixed one-row vertical drop on top of that. This keeps the
 * whole animation declarative CSS, no per-drop-computed transition.
 *
 * No randomness anywhere: hue and speed are pure functions of height, so the
 * opening frame is deterministic and safe for StrictMode's double-invoke.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Overlay,
  StatusLine,
  isTerminal,
  useBest,
  useFlash,
  useFrameLoop,
  useFullscreen,
  useGameOverReport,
  useShare,
  useTapAnywhere,
  type GameStatus,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./stack.module.css";

/** Virtual horizontal scale. Everything x/width-shaped lives on 0..VW. */
const VW = 300;
const START_WIDTH = 130;

/** How many row-heights the board can show at once. */
const ROWS_VISIBLE = 6;
const ROWPCT = 100 / ROWS_VISIBLE;
/** Once the camera engages, the current top block rests here from the bottom. */
const BASE_SCREEN_ROW = 1;
/** The active block slides this many rows above the current top. */
const ACTIVE_OFFSET = 3;

/** Within this many virtual units of dead-on, a drop snaps flush instead of shrinking. */
const PERFECT_TOL = 6;

const BASE_SPEED = 80; // units per second, at the base of the tower
const SPEED_STEP = 4; // added per row of height
const MAX_SPEED = 220;

const DROP_MS = 260; // matches the towerFall keyframe duration
const OFFCUT_MS = 700; // matches the towerOffcut keyframe duration

/** Only the last few rows are ever visible, so older blocks are dropped from state. */
const MAX_KEPT_BLOCKS = 14;

interface PlacedBlock {
  row: number;
  x: number;
  width: number;
  hue: number;
}
interface Landing {
  row: number;
  x: number;
  width: number;
  hue: number;
}
interface Offcut {
  id: number;
  row: number;
  x: number;
  width: number;
  hue: number;
  side: "left" | "right";
}

interface Game {
  status: GameStatus;
  blocks: PlacedBlock[]; // most recent last; always has at least the base
  topRow: number;
  activeX: number;
  activeWidth: number;
  dir: 1 | -1;
  dropping: boolean;
  landing: Landing | null;
  offcut: Offcut | null;
  score: number;
  combo: number;
  perfectCount: number;
}

/** A smooth hue sweep by height. The colour ramp is the reward for climbing. */
const hueForRow = (row: number) => (208 + row * 9) % 360;
const colorForHue = (hue: number) => `hsl(${hue} 62% 52%)`;

const speedForRow = (row: number) => Math.min(MAX_SPEED, BASE_SPEED + row * SPEED_STEP);

/** Deterministic opening frame: base block, still block centred above it. */
function initialGame(): Game {
  const base: PlacedBlock = { row: 0, x: (VW - START_WIDTH) / 2, width: START_WIDTH, hue: hueForRow(0) };
  return {
    status: "ready",
    blocks: [base],
    topRow: 0,
    activeX: base.x,
    activeWidth: base.width,
    dir: 1,
    dropping: false,
    landing: null,
    offcut: null,
    score: 0,
    combo: 0,
    perfectCount: 0,
  };
}

/**
 * Resolve one tap. `ready` just starts the slide. `playing` computes the
 * overlap with the block below: zero or negative overlap ends the run, a
 * near-dead-on hit snaps flush and scores a perfect, anything else narrows
 * the tower to the overlap and casts off the rest as a falling offcut.
 *
 * Returns the same object (by reference) when the tap has no effect, which
 * is how the caller knows not to flash anything.
 */
function dropBlock(g: Game): Game {
  if (g.status === "ready") return { ...g, status: "playing" };
  if (g.status !== "playing" || g.dropping) return g;

  const below = g.blocks[g.blocks.length - 1];
  const offset = g.activeX - below.x; // activeWidth === below.width always
  const overlapWidth = g.activeWidth - Math.abs(offset);

  if (overlapWidth <= 0) {
    return { ...g, status: "over" };
  }

  const perfect = Math.abs(offset) <= PERFECT_TOL;
  const row = g.topRow + 1;
  const hue = hueForRow(row);
  const x = perfect ? below.x : Math.max(g.activeX, below.x);
  const width = perfect ? below.width : overlapWidth;
  const offcutWidth = perfect ? 0 : Math.abs(offset);

  const offcut: Offcut | null =
    offcutWidth > 0.5
      ? {
          id: row,
          row,
          hue,
          width: offcutWidth,
          side: offset > 0 ? "right" : "left",
          x: offset > 0 ? below.x + below.width : g.activeX,
        }
      : null;

  const combo = perfect ? g.combo + 1 : 0;
  const perfectCount = g.perfectCount + (perfect ? 1 : 0);
  const score = g.score + 1 + (perfect ? combo * 5 : 0);

  return { ...g, dropping: true, landing: { row, x, width, hue }, offcut, combo, perfectCount, score };
}

/** Position and size a block, in board-relative percentages. */
function blockStyle(x: number, width: number, row: number, hue: number): CSSProperties {
  return {
    left: `${(x / VW) * 100}%`,
    width: `${(width / VW) * 100}%`,
    bottom: `${row * ROWPCT}%`,
    height: `${ROWPCT}%`,
    background: colorForHue(hue),
  };
}

export default function StackTower({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [flashMsg, flash] = useFlash();

  const [game, setGame] = useState<Game>(() => initialGame());
  const gameRef = useRef(game); // authoritative state read by the frame loop and the tap handler

  const commit = useCallback((next: Game) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  // The slide. Integrated against real elapsed time, not frames, so it holds
  // its speed regardless of display refresh rate. Frozen while a block is
  // mid-drop or the game isn't actively playing.
  useFrameLoop(game.status === "playing" && !game.dropping, (dtMs) => {
    const g = gameRef.current;
    const speed = speedForRow(g.topRow);
    const max = VW - g.activeWidth;
    let nx = g.activeX + g.dir * speed * (dtMs / 1000);
    let dir = g.dir;
    if (nx <= 0) {
      nx = 0;
      dir = 1;
    } else if (nx >= max) {
      nx = max;
      dir = -1;
    }
    commit({ ...g, activeX: nx, dir });
  });

  // Once the drop animation has had time to land, fold it into the stack and
  // spawn the next slider. A timer rather than `animationend` because the
  // reduced-motion path still needs this to happen on the same schedule.
  useEffect(() => {
    if (!game.dropping) return;
    const t = window.setTimeout(() => {
      const g = gameRef.current;
      if (!g.dropping || !g.landing) return;
      const placed: PlacedBlock = { row: g.landing.row, x: g.landing.x, width: g.landing.width, hue: g.landing.hue };
      commit({
        ...g,
        blocks: [...g.blocks, placed].slice(-MAX_KEPT_BLOCKS),
        topRow: placed.row,
        activeX: placed.x,
        activeWidth: placed.width,
        dropping: false,
        landing: null,
      });
    }, DROP_MS);
    return () => window.clearTimeout(t);
  }, [game.dropping, commit]);

  // The offcut lives a little longer than the drop, falling and fading on
  // its own clock, then clears itself.
  useEffect(() => {
    const id = game.offcut?.id;
    if (id == null) return;
    const t = window.setTimeout(() => {
      const g = gameRef.current;
      if (g.offcut?.id === id) commit({ ...g, offcut: null });
    }, OFFCUT_MS);
    return () => window.clearTimeout(t);
  }, [game.offcut?.id, commit]);

  const onTap = useCallback(() => {
    const g = gameRef.current;
    const next = dropBlock(g);
    if (next === g) return;
    const perfected = next.combo > g.combo;
    commit(next);
    if (perfected) flash(next.combo > 1 ? `Perfect! x${next.combo}` : "Perfect!");
  }, [commit, flash]);

  useTapAnywhere(onTap);

  const togglePause = useCallback(() => {
    const g = gameRef.current;
    if (g.status === "playing") commit({ ...g, status: "paused" });
    else if (g.status === "paused" || g.status === "ready") commit({ ...g, status: "playing" });
  }, [commit]);

  const restart = useCallback(() => commit(initialGame()), [commit]);

  const best = useBest(game.score);

  useGameOverReport(runtime, isTerminal(game.status), () => {
    const p = game.perfectCount === 1 ? "1 perfect" : `${game.perfectCount} perfects`;
    return `Stack Tower over. Height ${game.topRow}, ${p}, score ${game.score}.`;
  });

  const [shareStatus, share] = useShare(runtime);
  const tell = useCallback(() => {
    void share(
      `I stacked ${game.topRow} blocks in Stack Tower!`,
      `Stack Tower result: height ${game.topRow}, ${game.perfectCount} perfects, score ${game.score}.`,
    );
  }, [share, game.topRow, game.perfectCount, game.score]);

  const camY = Math.max(0, game.topRow - BASE_SCREEN_ROW) * ROWPCT;
  const upcomingHue = hueForRow(game.topRow + 1);
  const activeRow = game.topRow + ACTIVE_OFFSET;
  const showActive = !game.dropping && (game.status === "ready" || game.status === "playing" || game.status === "paused");

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} className={isFull ? s.fullBoard : ""}>
      <GameHeader
        title="Stack Tower"
        stats={[
          { label: "Height", value: game.topRow },
          { label: "Perfects", value: game.perfectCount },
          { label: "Best", value: best },
        ]}
        hint="Tap, click, or press Space to drop"
      />

      <div className={s.boardWrap}>
        <div
          className={s.board}
          role="img"
          aria-label={`Stack tower, height ${game.topRow}, score ${game.score}`}
        >
          <div className={s.world} style={{ transform: `translateY(${camY}%)` }}>
            {game.blocks.map((b) => (
              <div key={b.row} className={s.block} style={blockStyle(b.x, b.width, b.row, b.hue)} />
            ))}

            {showActive && (
              <div className={s.block} style={blockStyle(game.activeX, game.activeWidth, activeRow, upcomingHue)} />
            )}
            {game.status === "over" && !game.dropping && (
              <div
                className={`${s.block} ${s.miss}`}
                style={blockStyle(game.activeX, game.activeWidth, activeRow, upcomingHue)}
              />
            )}

            {game.landing && (
              <div
                className={`${s.block} ${s.landing}`}
                style={blockStyle(game.landing.x, game.landing.width, game.landing.row, game.landing.hue)}
              />
            )}

            {game.offcut && (
              <div
                key={game.offcut.id}
                className={`${s.block} ${game.offcut.side === "left" ? s.offcutLeft : s.offcutRight}`}
                style={blockStyle(game.offcut.x, game.offcut.width, game.offcut.row, game.offcut.hue)}
              />
            )}
          </div>

          {flashMsg && <div className={s.perfectBanner}>{flashMsg}</div>}

          <Overlay
            status={game.status}
            detail={
              game.status === "over"
                ? `Height ${game.topRow}, ${game.perfectCount} perfect${game.perfectCount === 1 ? "" : "s"}, score ${game.score}`
                : game.status === "ready"
                  ? "Tap, click, or press Space to drop"
                  : undefined
            }
            action={game.status === "over" ? "Play again" : game.status === "ready" ? "Play" : game.status === "paused" ? "Resume" : undefined}
            onAction={
              game.status === "over" ? restart : game.status === "ready" || game.status === "paused" ? togglePause : undefined
            }
          />
        </div>
      </div>

      <ControlBar>
        <button
          className={`${ui.btn} ${ui.primary}`}
          onClick={togglePause}
          disabled={isTerminal(game.status) || game.dropping}
        >
          {game.status === "playing" ? "Pause" : game.status === "paused" ? "Resume" : "Play"}
        </button>
        <button className={ui.btn} onClick={restart}>
          Restart
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
