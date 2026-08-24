/**
 * @file Flappy: one input, a gap, gravity.
 *
 * Physics run on `useFrameLoop` and integrate against real elapsed time
 * (`dtMs`), never a frame count, so the arc feels identical at 60Hz and
 * 120Hz. The whole game lives in one plain object (`Game`) that is
 * recomputed once per frame by the pure `tick` function and pushed into
 * both a ref (read by the loop, so it never closes over stale state) and
 * React state (so it renders) — the same authoritative-ref pattern Snake
 * and 2048 use.
 *
 * A virtual playfield of 360 by 480 units (`VW`/`VH`) is the only
 * coordinate space the physics ever see. Every rendered piece converts
 * its virtual position to a percentage of the board element, and because
 * the board's CSS aspect-ratio is locked to VW:VH, one virtual unit maps
 * to the same number of pixels on both axes, so the physics are correct
 * at any board size.
 *
 * Pipes are a fixed-size array (`PIPE_COUNT`), never grown: a pipe that
 * scrolls fully offscreen is repositioned past the others and given a new
 * gap instead of being replaced. Gap height is stored on each pipe at the
 * moment it is (re)placed, not derived from the live score, so a pipe's
 * drawn gap and its collision gap always agree even as the difficulty
 * narrows later pipes.
 *
 * Death is three beats: a short freeze (the moment of impact, held), a
 * tumble (gravity keeps pulling while the bird spins, ignoring the pipes
 * it already hit), then the game-over overlay once it lands. Reduced
 * motion skips straight from impact to game over.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  GameFrame,
  GameHeader,
  Overlay,
  StandardControls,
  StatusLine,
  clamp,
  isTerminal,
  useBest,
  useFrameLoop,
  useFullscreen,
  useGameOverReport,
  useShare,
  useTapAnywhere,
  type GameStatus,
} from "../lib/game";
import { randInt } from "../lib/rng";
import type { AppProps } from "../lib/runtime";
import s from "./flappy.module.css";

/** Virtual playfield. Every physics value lives in this space. */
const VW = 360;
const VH = 480;
const GROUND_H = 64;
const PLAY_BOTTOM = VH - GROUND_H; // y at which the ground begins

const BIRD_X = 104; // fixed horizontal position
const BIRD_D = 34; // drawn diameter
const BIRD_HIT_R = 12; // forgiving hitbox, smaller than the drawn bird

const GRAVITY = 1500; // px/s^2
const FLAP_VY = -430; // px/s, applied instantly on tap
const MAX_FALL_VY = 520; // px/s, terminal velocity
const TUMBLE_DEG_PER_S = 260; // spin rate while tumbling after death
const FREEZE_MS = 140; // hit-stun before the tumble starts

const PIPE_W = 56;
const PIPE_SPACING = 210;
const PIPE_COUNT = 3;
const PIPE_SPEED = 132; // px/s, constant regardless of score
const GAP_START = 156;
const GAP_MIN = 106;
const GAP_STEP = 3; // gap shrinks this much per point
const GAP_MARGIN = 30; // clearance kept from ceiling and ground

const gapForScore = (score: number) => Math.max(GAP_MIN, GAP_START - score * GAP_STEP);

/** A random gap centre that keeps the whole gap within the play area. */
function randomGapY(gap: number): number {
  const half = gap / 2;
  const lo = Math.round(GAP_MARGIN + half);
  const hi = Math.round(PLAY_BOTTOM - GAP_MARGIN - half);
  return randInt(Math.min(lo, hi), Math.max(lo, hi));
}

/** Nose up on a flap, tilting down as it falls. This is most of the feel. */
function rotFor(vy: number): number {
  if (vy <= 0) return clamp((vy / FLAP_VY) * -24, -24, 0);
  return clamp((vy / MAX_FALL_VY) * 88, 0, 88);
}

interface Pipe {
  x: number;
  gapY: number;
  /** Gap height at the moment this pipe was placed, so it never drifts out
   *  of sync with the collision check as later pipes narrow. */
  gap: number;
  passed: boolean;
}
interface Bird {
  y: number;
  vy: number;
}
type Phase = "ready" | "playing" | "paused" | "dying" | "falling" | "over";

interface Game {
  phase: Phase;
  bird: Bird;
  pipes: Pipe[];
  score: number;
  freezeMs: number;
  fallRot: number;
}

/** Deterministic opening state: no randomness, so StrictMode's double
 *  invocation produces an identical board both times. */
function newGame(): Game {
  return {
    phase: "ready",
    bird: { y: VH / 2, vy: 0 },
    pipes: Array.from({ length: PIPE_COUNT }, (_, i) => ({
      x: VW + 50 + i * PIPE_SPACING,
      gapY: VH / 2,
      gap: GAP_START,
      passed: false,
    })),
    score: 0,
    freezeMs: 0,
    fallRot: 0,
  };
}

/** A fresh run. Randomness only happens here, on the player's own tap. */
function startRun(): Game {
  return {
    phase: "playing",
    bird: { y: VH / 2, vy: FLAP_VY },
    pipes: Array.from({ length: PIPE_COUNT }, (_, i) => ({
      x: VW + 60 + i * PIPE_SPACING,
      gapY: randomGapY(GAP_START),
      gap: GAP_START,
      passed: false,
    })),
    score: 0,
    freezeMs: 0,
    fallRot: 0,
  };
}

/** One frame of simulation. Pure: same inputs, same result. */
function tick(g: Game, dtMs: number, reducedMotion: boolean): Game {
  const dt = dtMs / 1000;

  if (g.phase === "playing") {
    const vy = Math.min(g.bird.vy + GRAVITY * dt, MAX_FALL_VY);
    const y = g.bird.y + vy * dt;
    let score = g.score;

    const pipes = g.pipes.map((p) => ({ ...p, x: p.x - PIPE_SPEED * dt }));
    for (const p of pipes) {
      if (!p.passed && p.x + PIPE_W < BIRD_X) {
        p.passed = true;
        score += 1;
      }
    }
    // Recycle whichever pipe has fully scrolled off the left edge, rather
    // than growing the array: send it past the current rightmost pipe with
    // a freshly randomised gap.
    const rightmost = Math.max(...pipes.map((p) => p.x));
    for (const p of pipes) {
      if (p.x + PIPE_W < -PIPE_W) {
        const gap = gapForScore(score);
        p.x = rightmost + PIPE_SPACING;
        p.gapY = randomGapY(gap);
        p.gap = gap;
        p.passed = false;
      }
    }

    let dead = y - BIRD_HIT_R <= 0 || y + BIRD_HIT_R >= PLAY_BOTTOM;
    if (!dead) {
      for (const p of pipes) {
        if (BIRD_X + BIRD_HIT_R <= p.x || BIRD_X - BIRD_HIT_R >= p.x + PIPE_W) continue;
        const gapTop = p.gapY - p.gap / 2;
        const gapBottom = p.gapY + p.gap / 2;
        if (y - BIRD_HIT_R < gapTop || y + BIRD_HIT_R > gapBottom) {
          dead = true;
          break;
        }
      }
    }

    if (dead) {
      const bird = { y: clamp(y, BIRD_HIT_R, PLAY_BOTTOM - BIRD_HIT_R), vy };
      return reducedMotion
        ? { ...g, phase: "over", bird, pipes, score }
        : { ...g, phase: "dying", bird, pipes, score, freezeMs: 0 };
    }
    return { ...g, bird: { y, vy }, pipes, score };
  }

  if (g.phase === "dying") {
    const freezeMs = g.freezeMs + dtMs;
    if (freezeMs >= FREEZE_MS) return { ...g, phase: "falling", fallRot: rotFor(g.bird.vy) };
    return { ...g, freezeMs };
  }

  if (g.phase === "falling") {
    const vy = Math.min(g.bird.vy + GRAVITY * dt, MAX_FALL_VY);
    const y = g.bird.y + vy * dt;
    const fallRot = g.fallRot + TUMBLE_DEG_PER_S * dt;
    if (y + BIRD_HIT_R >= PLAY_BOTTOM) {
      return { ...g, phase: "over", bird: { y: PLAY_BOTTOM - BIRD_HIT_R, vy: 0 }, fallRot };
    }
    return { ...g, bird: { y, vy }, fallRot };
  }

  return g; // ready, paused, over: nothing to simulate
}

/** The bird. One or two literal colours are the guide's own exception. */
function BirdIcon() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <ellipse cx="15" cy="17" rx="12" ry="10" fill="#ffcb3d" />
      <path className={s.wing} d="M5 15 Q -2 18 4 23 Q 11 21 10 16 Z" fill="#f2a72c" />
      <path d="M25 15 L32 17.5 L25 20 Z" fill="#ff7a30" />
      <circle cx="20.5" cy="12.5" r="3.6" fill="#ffffff" />
      <circle cx="21.8" cy="12.2" r="1.8" fill="#2b2b2b" />
    </svg>
  );
}

export default function Flappy({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);

  const [game, setGame] = useState<Game>(() => newGame());
  const gameRef = useRef(game);
  const reducedMotionRef = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    reducedMotionRef.current = mq.matches;
    const onChange = () => { reducedMotionRef.current = mq.matches; };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const commit = useCallback((next: Game) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  const loopRunning = game.phase === "playing" || game.phase === "dying" || game.phase === "falling";
  useFrameLoop(loopRunning, (dtMs) => {
    commit(tick(gameRef.current, dtMs, reducedMotionRef.current));
  });

  const startGame = useCallback(() => commit(startRun()), [commit]);

  const flap = useCallback(() => {
    const g = gameRef.current;
    if (g.phase !== "playing") return;
    commit({ ...g, bird: { ...g.bird, vy: FLAP_VY } });
  }, [commit]);

  // The one input: tap, click, Space or Enter. Ready or over both start a
  // fresh run instantly; mid-run it flaps; a hit stun or tumble ignores it.
  const handleTap = useCallback(() => {
    const g = gameRef.current;
    if (g.phase === "ready" || g.phase === "over") startGame();
    else if (g.phase === "playing") flap();
  }, [startGame, flap]);
  useTapAnywhere(handleTap);

  const onPlayPause = useCallback(() => {
    const g = gameRef.current;
    if (g.phase === "ready" || g.phase === "over") startGame();
    else if (g.phase === "playing") commit({ ...g, phase: "paused" });
    else if (g.phase === "paused") commit({ ...g, phase: "playing" });
  }, [commit, startGame]);

  const restart = useCallback(() => commit(newGame()), [commit]);

  const best = useBest(game.score);

  const overlayStatus: GameStatus =
    game.phase === "ready"
      ? "ready"
      : game.phase === "paused"
        ? "paused"
        : game.phase === "over"
          ? "over"
          : "playing";

  useGameOverReport(runtime, isTerminal(overlayStatus), () =>
    `Flappy over. Score ${game.score}, best ${Math.max(best, game.score)}.`,
  );

  const [shareStatus, share] = useShare(runtime);
  const tell = useCallback(() => {
    void share(`I scored ${game.score} in Flappy!`, `Flappy result: score ${game.score}.`);
  }, [share, game.score]);

  const rot = game.phase === "falling" ? game.fallRot : rotFor(game.bird.vy);
  const dying = game.phase === "dying" || game.phase === "falling";

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} className={isFull ? s.fullBoard : ""}>
      <GameHeader
        title="Flappy"
        stats={[
          { label: "Score", value: <span key={game.score} className={s.scorePop}>{game.score}</span> },
          { label: "Best", value: best },
        ]}
        hint="Tap, click or press Space to fly"
      />

      <div className={s.boardWrap}>
        <div
          className={`${s.board} ${dying ? s.hit : ""}`}
          role="img"
          aria-label={`Flappy board. Score ${game.score}${game.phase === "over" ? ", game over" : ""}.`}
        >
          <div className={s.skyFar} aria-hidden="true" />
          <div className={s.skyNear} aria-hidden="true" />

          {game.pipes.map((p, i) => {
            const gapTop = p.gapY - p.gap / 2;
            const gapBottom = p.gapY + p.gap / 2;
            return (
              <div
                key={i}
                className={s.pipePair}
                style={{ left: `${(p.x / VW) * 100}%`, width: `${(PIPE_W / VW) * 100}%` }}
              >
                <div className={s.pipeTop} style={{ height: `${(gapTop / VH) * 100}%` }}>
                  <div className={s.pipeLip} />
                </div>
                <div
                  className={s.pipeBottom}
                  style={{ height: `${((PLAY_BOTTOM - gapBottom) / VH) * 100}%` }}
                >
                  <div className={s.pipeLip} />
                </div>
              </div>
            );
          })}

          <div className={s.ground} aria-hidden="true" style={{ height: `${(GROUND_H / VH) * 100}%` }} />

          <div
            className={s.birdPos}
            style={{
              left: `${(BIRD_X / VW) * 100}%`,
              top: `${(game.bird.y / VH) * 100}%`,
              width: `${(BIRD_D / VW) * 100}%`,
              height: `${(BIRD_D / VH) * 100}%`,
            }}
          >
            <div
              className={`${s.birdRotate} ${game.phase === "ready" ? s.hover : ""}`}
              style={game.phase === "ready" ? undefined : { transform: `rotate(${rot}deg)` }}
            >
              <BirdIcon />
            </div>
          </div>

          <Overlay
            status={overlayStatus}
            detail={
              overlayStatus === "ready"
                ? "Tap, click or press Space to fly"
                : overlayStatus === "over"
                  ? `Score ${game.score}, best ${best}`
                  : undefined
            }
            action={
              overlayStatus === "ready" ? "Play" : overlayStatus === "over" ? "Play again" : overlayStatus === "paused" ? "Resume" : undefined
            }
            onAction={overlayStatus === "over" ? startGame : onPlayPause}
          />
        </div>
      </div>

      <StandardControls
        status={overlayStatus}
        onPause={onPlayPause}
        onRestart={restart}
        fullscreen={isFull}
        onFullscreen={toggleFull}
        onShare={tell}
      />
      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
