/**
 * @file Aim Trainer: thirty (or fifteen, or sixty) seconds of targets.
 *
 * One target at a time. Tap it to score and spawn the next; tap anywhere
 * else on the board and it counts as a miss. The whole point of a game this
 * small is the quality of the measurement, so every reaction time is taken
 * with `performance.now()` (never `Date.now()`, which is too coarse) and
 * every sample is kept, not just a running average, so the results screen
 * can show best, worst, mean and median, plus a sparkline of the whole run.
 *
 * Coordinates split in two: target *position* is a percentage of the board
 * (`--x`/`--y`, unitless custom properties multiplied by 1% in CSS, the same
 * trick Snake uses for its grid), so it scales cleanly with the board's
 * percentage-based size. Target *size* is real CSS pixels (`--size`), which
 * is what lets it shrink with score while never dropping below the 44px
 * minimum touch target on a phone.
 *
 * The opening target is centred and fixed, not random: React StrictMode
 * double-invokes state initialisers, and a random starting position could
 * differ between those two passes. Every target after it is randomised, seeded
 * from the player's own taps rather than from component construction.
 */
import { useCallback, useRef, useState, type PointerEvent } from "react";
import { randInt } from "../lib/rng";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Overlay,
  Segmented,
  StandardControls,
  StatusLine,
  isTerminal,
  sv,
  useBest,
  useCountdown,
  useFullscreen,
  useGameOverReport,
  useShare,
  type GameStatus,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import s from "./aim.module.css";

const BASE_SIZE = 72; // px, the largest a target gets
const MIN_SIZE = 44; // px, the WCAG-ish touch-target floor: never smaller
const SHRINK_PER_HIT = 1.6; // px shaved off per hit, floored at MIN_SIZE
const EDGE_PAD = 6; // px of extra breathing room past the target's own radius

type Duration = "15" | "30" | "60";
const DURATIONS: { value: Duration; label: string }[] = [
  { value: "15", label: "15s" },
  { value: "30", label: "30s" },
  { value: "60", label: "60s" },
];

interface Target {
  xPct: number;
  yPct: number;
  size: number;
  shownAt: number;
}

interface Game {
  status: GameStatus;
  target: Target;
  hits: number;
  taps: number; // hits + misses; accuracy is hits / taps
  samples: number[]; // one reaction time per hit, in ms
}

interface Effect {
  id: number;
  kind: "hit" | "miss";
  xPct: number;
  yPct: number;
  size: number;
}

const sizeForHits = (hits: number) => Math.max(MIN_SIZE, Math.round(BASE_SIZE - hits * SHRINK_PER_HIT));

/** A fresh target at a random spot fully inside the board, given its measured pixel size. */
function randomTarget(boardW: number, boardH: number, hits: number): Target {
  const size = sizeForHits(hits);
  const half = size / 2 + EDGE_PAD;
  const xPct =
    boardW > half * 2 ? (randInt(Math.round(half), Math.round(boardW - half)) / boardW) * 100 : 50;
  const yPct =
    boardH > half * 2 ? (randInt(Math.round(half), Math.round(boardH - half)) / boardH) * 100 : 50;
  return { xPct, yPct, size, shownAt: performance.now() };
}

/** Deterministic opening frame: one centred target, ready to be the first tap. */
function initialGame(): Game {
  return {
    status: "ready",
    target: { xPct: 50, yPct: 50, size: BASE_SIZE, shownAt: performance.now() },
    hits: 0,
    taps: 0,
    samples: [],
  };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Reaction times across the round as an SVG polyline, with a faint mean line. */
function Sparkline({ samples }: { samples: number[] }) {
  const W = 280;
  const H = 56;
  const PAD = 6;
  const lo = Math.min(...samples);
  const hi = Math.max(...samples);
  const span = Math.max(1, hi - lo);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
  const x = (i: number) => (samples.length > 1 ? PAD + (i / (samples.length - 1)) * (W - PAD * 2) : W / 2);
  const y = (v: number) => PAD + (1 - (v - lo) / span) * (H - PAD * 2);
  const points = samples.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const meanY = y(mean).toFixed(1);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={s.sparkline}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Reaction time across the round, from ${Math.round(lo)} to ${Math.round(hi)} milliseconds`}
    >
      <line x1={PAD} y1={meanY} x2={W - PAD} y2={meanY} className={s.sparkMean} />
      <polyline points={points} className={s.sparkLine} />
    </svg>
  );
}

export default function AimTrainer({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);

  const [game, setGame] = useState<Game>(() => initialGame());
  const gameRef = useRef(game); // read fresh state from pointer handlers without stale closures
  const commit = useCallback((next: Game) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  const [duration, setDuration] = useState<Duration>("30");
  const durationSec = Number(duration);

  const [effects, setEffects] = useState<Effect[]>([]);
  const effectIdRef = useRef(0);
  const addEffect = useCallback((kind: Effect["kind"], xPct: number, yPct: number, size: number) => {
    const id = ++effectIdRef.current;
    setEffects((cur) => [...cur, { id, kind, xPct, yPct, size }]);
    window.setTimeout(() => setEffects((cur) => cur.filter((e) => e.id !== id)), kind === "hit" ? 480 : 260);
  }, []);

  const onExpire = useCallback(() => {
    const g = gameRef.current;
    if (g.status === "playing") commit({ ...g, status: "over" });
  }, [commit]);
  const [timeLeft, resetCountdown] = useCountdown(durationSec, game.status === "playing", onExpire);

  const handleDurationChange = useCallback(
    (v: Duration) => {
      setDuration(v);
      if (gameRef.current.status !== "playing") resetCountdown(Number(v));
    },
    [resetCountdown],
  );

  const restart = useCallback(() => {
    setEffects([]);
    commit(initialGame());
    resetCountdown(durationSec);
  }, [commit, durationSec, resetCountdown]);

  // The centred ready target doubles as the round's first hit: tapping it
  // both starts play and records the very first reaction time.
  const onTargetPointerDown = useCallback(
    (e: PointerEvent<HTMLButtonElement>) => {
      e.stopPropagation(); // a hit is never also a miss on the board beneath it
      const g = gameRef.current;
      if (g.status !== "ready" && g.status !== "playing") return;

      const now = performance.now();
      const reaction = now - g.target.shownAt;
      const rect = boardRef.current?.getBoundingClientRect();
      const boardW = rect?.width ?? 0;
      const boardH = rect?.height ?? 0;
      const hitXPct = rect && rect.width ? ((e.clientX - rect.left) / rect.width) * 100 : g.target.xPct;
      const hitYPct = rect && rect.height ? ((e.clientY - rect.top) / rect.height) * 100 : g.target.yPct;

      if (g.status === "ready") {
        commit({
          status: "playing",
          target: randomTarget(boardW, boardH, 1),
          hits: 1,
          taps: 1,
          samples: [reaction],
        });
      } else {
        const hits = g.hits + 1;
        commit({
          ...g,
          target: randomTarget(boardW, boardH, hits),
          hits,
          taps: g.taps + 1,
          samples: [...g.samples, reaction],
        });
      }
      addEffect("hit", hitXPct, hitYPct, g.target.size);
    },
    [commit, addEffect],
  );

  const onBoardPointerDown = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const g = gameRef.current;
      if (g.status !== "playing") return; // ready/over taps that miss the target do nothing
      const rect = boardRef.current?.getBoundingClientRect();
      const xPct = rect && rect.width ? ((e.clientX - rect.left) / rect.width) * 100 : 50;
      const yPct = rect && rect.height ? ((e.clientY - rect.top) / rect.height) * 100 : 50;
      commit({ ...g, taps: g.taps + 1 });
      addEffect("miss", xPct, yPct, 0);
    },
    [commit, addEffect],
  );

  const accuracyPct = game.taps > 0 ? Math.round((game.hits / game.taps) * 100) : 100;
  const mean = game.samples.length ? game.samples.reduce((a, b) => a + b, 0) / game.samples.length : 0;
  const bestReaction = game.samples.length ? Math.min(...game.samples) : 0;
  const worstReaction = game.samples.length ? Math.max(...game.samples) : 0;
  const med = median(game.samples);
  const tpm = durationSec > 0 ? (game.hits / durationSec) * 60 : 0;
  const bestHits = useBest(game.hits);

  useGameOverReport(runtime, isTerminal(game.status), () =>
    `Aim Trainer over. ${game.hits} hits, ${accuracyPct}% accuracy, mean reaction ${Math.round(mean)} ms, ` +
      `best ${Math.round(bestReaction)} ms, ${tpm.toFixed(1)} targets per minute over ${durationSec}s.`,
  );

  const [shareStatus, share] = useShare(runtime);
  const tell = useCallback(() => {
    void share(
      `I hit ${game.hits} targets in Aim Trainer, ${accuracyPct}% accuracy!`,
      `Aim Trainer result: ${game.hits} hits, ${accuracyPct}% accuracy, mean ${Math.round(mean)} ms, best ${Math.round(bestReaction)} ms.`,
    );
  }, [share, game.hits, accuracyPct, mean, bestReaction]);

  const boardLabel =
    game.status === "over"
      ? `Aim trainer round over, ${game.hits} hits, ${accuracyPct}% accuracy`
      : game.status === "playing"
        ? `Aim trainer, ${game.hits} hits, ${timeLeft} seconds left`
        : "Aim trainer, tap the target to start";

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={isFull ? s.fullBoard : ""}>
      <GameHeader
        title="Aim Trainer"
        stats={[
          { label: "Hits", value: game.hits },
          { label: "Accuracy", value: `${accuracyPct}%` },
          { label: "Time left", value: timeLeft },
        ]}
        hint={game.status === "ready" ? "Tap the target to start" : undefined}
      />

      <div className={s.boardWrap}>
        <div ref={boardRef} className={s.board} role="img" aria-label={boardLabel} onPointerDown={onBoardPointerDown}>
          {(game.status === "ready" || game.status === "playing") && (
            <button
              type="button"
              className={`${s.target} ${game.status === "ready" ? s.targetStart : ""}`}
              style={sv({ "--x": game.target.xPct, "--y": game.target.yPct, "--size": `${game.target.size}px` })}
              aria-label={game.status === "ready" ? "Start" : "Target"}
              onPointerDown={onTargetPointerDown}
            >
              {game.status === "ready" && <span className={s.targetLabel}>GO</span>}
            </button>
          )}

          {effects.map((e) => (
            <span
              key={e.id}
              aria-hidden="true"
              className={e.kind === "hit" ? s.ripple : s.missFlash}
              style={sv({ "--x": e.xPct, "--y": e.yPct, "--size": `${e.size || 46}px` })}
            />
          ))}

          {game.status === "over" && (
            <Overlay status="over" title="Round over" detail={`${durationSec}s round`} action="Play again" onAction={restart}>
              <div className={s.resultGrid}>
                <div className={s.resultStat}><span>Hits</span><b>{game.hits}</b></div>
                <div className={s.resultStat}><span>Accuracy</span><b>{accuracyPct}%</b></div>
                <div className={s.resultStat}><span>Mean</span><b>{Math.round(mean)} ms</b></div>
                <div className={s.resultStat}><span>Median</span><b>{Math.round(med)} ms</b></div>
                <div className={s.resultStat}><span>Best reaction</span><b>{Math.round(bestReaction)} ms</b></div>
                <div className={s.resultStat}><span>Worst reaction</span><b>{Math.round(worstReaction)} ms</b></div>
                <div className={s.resultStat}><span>Per minute</span><b>{tpm.toFixed(1)}</b></div>
                <div className={s.resultStat}><span>Session best</span><b>{bestHits} hits</b></div>
              </div>
              <Sparkline samples={game.samples} />
            </Overlay>
          )}
        </div>
      </div>

      <ControlBar>
        <Segmented label="Duration" options={DURATIONS} value={duration} onChange={handleDurationChange} />
      </ControlBar>

      <StandardControls
        status={game.status}
        onRestart={restart}
        fullscreen={isFull}
        onFullscreen={toggleFull}
        onShare={tell}
      />
      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
