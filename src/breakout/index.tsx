/**
 * @file Breakout: paddle, bricks, powerups.
 *
 * Two details separate this from the usual clone.
 *
 * **Paddle reflection depends on where the ball lands.** Centre sends it
 * straight up, the edges send it out at an angle. A paddle that reflects at
 * the mirror angle makes the game a chore, because the player has no way to
 * aim. The vertical component is floored so the ball can never end up
 * travelling almost horizontally and stall forever.
 *
 * **Collision is swept, not sampled.** At high ball speed, testing whether the
 * ball is currently inside a brick misses entirely: at 400 units per second on
 * a 500-unit field, a frame can carry the ball clean through a 20-unit brick.
 * Instead the ball's path across the frame is tested against every candidate
 * edge, the nearest hit is resolved, the velocity reflects on that axis, and
 * the remaining time is replayed. That loop runs up to four times a frame,
 * which is enough for any speed this game reaches.
 *
 * Everything lives on a fixed virtual field scaled by CSS, so the physics are
 * identical whatever size the host gives us, and motion integrates against
 * elapsed milliseconds rather than counting frames.
 */
import { useCallback, useRef, useState, type PointerEvent } from "react";
import { randInt } from "../lib/rng";
import {
  ControlBar,
  DPad,
  GameFrame,
  GameHeader,
  Overlay,
  StatusLine,
  clamp,
  isTerminal,
  seedString,
  sv,
  useFrameLoop,
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
import s from "./breakout.module.css";

/** Virtual field. Everything below is in these units. */
const VW = 400;
const VH = 500;

const COLS = 10;
const BRICK_W = 36;
const BRICK_H = 16;
const BRICK_TOP = 60;
const BRICK_GAP = 4;
const FIELD_PAD = (VW - (COLS * BRICK_W + (COLS - 1) * BRICK_GAP)) / 2;

const PADDLE_Y = VH - 26;
const PADDLE_H = 10;
const PADDLE_W = 72;
const PADDLE_W_WIDE = 112;

const BALL_R = 6;
const BALL_SPEED_START = 250;
const BALL_SPEED_MAX = 460;
const BALL_SPEED_GAIN = 6; // per brick broken
/** Never let the ball travel so flat that it cannot come back down. */
const MIN_VY_RATIO = 0.35;

const LIVES_START = 3;
const POWER_MS = 9000;
const POWER_DROP_SPEED = 130;

/**
 * Levels as string art. Digits are hit points, a space is a gap. Ten columns
 * wide to match the field.
 */
const LAYOUTS: string[][] = [
  [
    "1111111111",
    "1111111111",
    "2222222222",
    "          ",
    "1111111111",
  ],
  [
    "  111111  ",
    " 22222222 ",
    "2233333322",
    " 22222222 ",
    "  111111  ",
  ],
  [
    "3   1111 3",
    "33  2222 3",
    "333 3333 3",
    "33  2222 3",
    "3   1111 3",
  ],
  [
    "1 2 3 3 2 ",
    " 2 3 3 2 1",
    "3 3 2 2 1 ",
    " 3 2 2 1 3",
    "2 2 1 1 3 ",
  ],
];

type Power = "wide" | "multi" | "slow";

interface Brick {
  x: number;
  y: number;
  hp: number;
  max: number;
  alive: boolean;
}

interface Ball {
  x: number;
  y: number;
  vx: number;
  vy: number;
  id: number;
}

interface Drop {
  x: number;
  y: number;
  kind: Power;
  id: number;
}

interface Game {
  bricks: Brick[];
  balls: Ball[];
  drops: Drop[];
  paddleX: number;
  level: number;
  score: number;
  lives: number;
  status: GameStatus;
  /** Ball sits on the paddle until served. */
  serving: boolean;
  broke: number;
  perfect: boolean;
  powers: Record<Power, number>; // ms remaining
  nextId: number;
}

function buildBricks(level: number): Brick[] {
  const layout = LAYOUTS[level % LAYOUTS.length];
  const bricks: Brick[] = [];
  layout.forEach((row, r) => {
    for (let c = 0; c < COLS; c++) {
      const ch = row[c] ?? " ";
      if (ch === " ") continue;
      const hp = Number(ch);
      if (!Number.isFinite(hp) || hp < 1) continue;
      bricks.push({
        x: FIELD_PAD + c * (BRICK_W + BRICK_GAP),
        y: BRICK_TOP + r * (BRICK_H + BRICK_GAP),
        hp,
        max: hp,
        alive: true,
      });
    }
  });
  return bricks;
}

/** Deterministic: no randomness, safe in a state initialiser. */
function newGame(level = 0): Game {
  return {
    bricks: buildBricks(level),
    balls: [{ x: VW / 2, y: PADDLE_Y - BALL_R - 1, vx: 0, vy: 0, id: 1 }],
    drops: [],
    paddleX: VW / 2,
    level,
    score: 0,
    lives: LIVES_START,
    status: "ready",
    serving: true,
    broke: 0,
    perfect: true,
    powers: { wide: 0, multi: 0, slow: 0 },
    nextId: 2,
  };
}

const paddleWidth = (g: Game) => (g.powers.wide > 0 ? PADDLE_W_WIDE : PADDLE_W);

/** Speed for the current brick count, capped, halved while slow is active. */
function currentSpeed(g: Game): number {
  const base = Math.min(BALL_SPEED_MAX, BALL_SPEED_START + g.broke * BALL_SPEED_GAIN);
  return g.powers.slow > 0 ? base * 0.62 : base;
}

/** Re-normalise a velocity to `speed`, keeping enough vertical component. */
function retarget(vx: number, vy: number, speed: number): { vx: number; vy: number } {
  let ux = vx;
  let uy = vy;
  const len = Math.hypot(ux, uy) || 1;
  ux /= len;
  uy /= len;
  if (Math.abs(uy) < MIN_VY_RATIO) {
    const sign = uy === 0 ? -1 : Math.sign(uy);
    uy = sign * MIN_VY_RATIO;
    const room = 1 - uy * uy;
    ux = Math.sign(ux || 1) * Math.sqrt(Math.max(room, 0));
  }
  return { vx: ux * speed, vy: uy * speed };
}

interface Hit {
  /** Fraction of the step at which the hit happens, 0 to 1. */
  t: number;
  axis: "x" | "y";
  brick: Brick | null;
}

/**
 * Earliest collision along the ball's path this step. Expanding each brick by
 * the ball radius turns a moving circle against a rectangle into a point
 * against a rounded rectangle, which for axis-aligned bricks is close enough
 * and far cheaper than the exact test.
 */
function sweep(ball: Ball, dx: number, dy: number, bricks: Brick[]): Hit | null {
  let best: Hit | null = null;

  const consider = (t: number, axis: "x" | "y", brick: Brick | null) => {
    if (t < 0 || t > 1) return;
    if (!best || t < best.t) best = { t, axis, brick };
  };

  // Walls.
  if (dx < 0) consider((BALL_R - ball.x) / dx, "x", null);
  if (dx > 0) consider((VW - BALL_R - ball.x) / dx, "x", null);
  if (dy < 0) consider((BALL_R - ball.y) / dy, "y", null);

  for (const b of bricks) {
    if (!b.alive) continue;
    const left = b.x - BALL_R;
    const right = b.x + BRICK_W + BALL_R;
    const top = b.y - BALL_R;
    const bottom = b.y + BRICK_H + BALL_R;

    // Slab test: the interval of t where the path overlaps the expanded box.
    let tMin = 0;
    let tMax = 1;
    let axis: "x" | "y" = "x";

    for (const [p, d, lo, hi, ax] of [
      [ball.x, dx, left, right, "x"] as const,
      [ball.y, dy, top, bottom, "y"] as const,
    ]) {
      if (Math.abs(d) < 1e-9) {
        if (p < lo || p > hi) {
          tMin = 1;
          tMax = -1;
          break;
        }
        continue;
      }
      let t1 = (lo - p) / d;
      let t2 = (hi - p) / d;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tMin) {
        tMin = t1;
        axis = ax;
      }
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) break;
    }

    if (tMin <= tMax && tMin >= 0 && tMin <= 1) consider(tMin, axis, b);
  }

  return best;
}

export default function Breakout({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);
  const topic = seedString(seed, "topic");

  const [game, setGame] = useState<Game>(() => newGame(0));
  const gameRef = useRef(game);
  gameRef.current = game;
  const fieldRef = useRef<HTMLDivElement>(null);

  const commit = useCallback((next: Game) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  const serve = useCallback(() => {
    const g = gameRef.current;
    if (isTerminal(g.status)) return;
    if (!g.serving) return;
    // Serve angle is deterministic per serve count, so StrictMode cannot
    // produce two different opening trajectories.
    const dir = g.broke % 2 === 0 ? 1 : -1;
    const v = retarget(dir * 0.55, -1, currentSpeed(g));
    commit({
      ...g,
      status: "playing",
      serving: false,
      balls: [{ ...g.balls[0], vx: v.vx, vy: v.vy }],
    });
  }, [commit]);

  const movePaddle = useCallback(
    (x: number) => {
      const g = gameRef.current;
      if (isTerminal(g.status)) return;
      const w = paddleWidth(g);
      const px = clamp(x, w / 2, VW - w / 2);
      commit({
        ...g,
        paddleX: px,
        balls: g.serving ? [{ ...g.balls[0], x: px }] : g.balls,
      });
    },
    [commit],
  );

  const onDirection = useCallback(
    (dir: Direction) => {
      if (dir !== "left" && dir !== "right") return;
      movePaddle(gameRef.current.paddleX + (dir === "left" ? -26 : 26));
    },
    [movePaddle],
  );

  useKeys({
    arrowleft: () => onDirection("left"),
    arrowright: () => onDirection("right"),
    a: () => onDirection("left"),
    d: () => onDirection("right"),
    " ": serve,
    enter: serve,
  });

  /** Pointer tracking: the best way to play, so it maps straight through. */
  const onPointer = useCallback(
    (e: PointerEvent<HTMLDivElement>) => {
      const el = fieldRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      movePaddle(((e.clientX - rect.left) / rect.width) * VW);
    },
    [movePaddle],
  );

  useFrameLoop(game.status === "playing" && !game.serving, (dtMs) => {
    const g = gameRef.current;
    if (g.status !== "playing" || g.serving) return;
    const dt = dtMs / 1000;
    const speed = currentSpeed(g);

    const bricks = g.bricks.map((b) => ({ ...b }));
    let { score, broke, lives, perfect, nextId } = g;
    const powers = { ...g.powers };
    for (const k of Object.keys(powers) as Power[]) powers[k] = Math.max(0, powers[k] - dtMs);

    const drops: Drop[] = [];
    const w = powers.wide > 0 ? PADDLE_W_WIDE : PADDLE_W;

    // Falling powerups.
    for (const d of g.drops) {
      const y = d.y + POWER_DROP_SPEED * dt;
      if (y > VH) continue;
      const caught = y >= PADDLE_Y - 6 && y <= PADDLE_Y + PADDLE_H + 6 && Math.abs(d.x - g.paddleX) <= w / 2 + 8;
      if (caught) {
        powers[d.kind] = POWER_MS;
        if (d.kind === "multi") {
          // Split the leading ball into three.
          const lead = g.balls[0];
          if (lead) {
            for (const angle of [-0.5, 0.5]) {
              const v = retarget(lead.vx * Math.cos(angle) - lead.vy * Math.sin(angle), lead.vx * Math.sin(angle) + lead.vy * Math.cos(angle), speed);
              g.balls.push({ x: lead.x, y: lead.y, vx: v.vx, vy: v.vy, id: nextId++ });
            }
          }
        }
        continue;
      }
      drops.push({ ...d, y });
    }

    const balls: Ball[] = [];
    for (const ball of g.balls) {
      let bx = ball.x;
      let by = ball.y;
      let vx = ball.vx;
      let vy = ball.vy;

      // Swept resolution, replayed for the remaining time after each hit.
      let remaining = dt;
      for (let pass = 0; pass < 4 && remaining > 1e-6; pass++) {
        const dx = vx * remaining;
        const dy = vy * remaining;
        const hit = sweep({ ...ball, x: bx, y: by }, dx, dy, bricks);
        if (!hit) {
          bx += dx;
          by += dy;
          remaining = 0;
          break;
        }
        // Step to just before contact, then reflect.
        const eps = 1e-4;
        bx += dx * Math.max(0, hit.t - eps);
        by += dy * Math.max(0, hit.t - eps);
        if (hit.axis === "x") vx = -vx;
        else vy = -vy;

        if (hit.brick) {
          const target = bricks.find((b) => b === hit.brick);
          if (target && target.alive) {
            target.hp -= 1;
            if (target.hp <= 0) {
              target.alive = false;
              score += 10 * target.max;
              broke += 1;
              // One in five bricks carries something.
              if (randInt(1, 5) === 1) {
                const kind: Power = (["wide", "multi", "slow"] as Power[])[randInt(0, 2)];
                drops.push({ x: target.x + BRICK_W / 2, y: target.y + BRICK_H, kind, id: nextId++ });
              }
            } else {
              score += 5;
            }
          }
        }

        remaining *= 1 - hit.t;
      }

      // Paddle: reflection angle depends on where it lands.
      if (vy > 0 && by + BALL_R >= PADDLE_Y && by - BALL_R <= PADDLE_Y + PADDLE_H) {
        const offset = (bx - g.paddleX) / (w / 2);
        if (Math.abs(offset) <= 1.15) {
          const angle = clamp(offset, -1, 1) * 1.05; // up to about 60 degrees
          const v = retarget(Math.sin(angle), -Math.cos(angle), speed);
          vx = v.vx;
          vy = v.vy;
          by = PADDLE_Y - BALL_R - 1;
        }
      }

      if (by - BALL_R > VH) continue; // lost
      const v = retarget(vx, vy, speed);
      balls.push({ ...ball, x: bx, y: by, vx: v.vx, vy: v.vy });
    }

    // Losing every ball costs a life.
    if (balls.length === 0) {
      lives -= 1;
      perfect = false;
      if (lives <= 0) {
        commit({ ...g, bricks, drops: [], balls: [], lives: 0, score, broke, perfect, powers, status: "over", nextId });
        return;
      }
      commit({
        ...g,
        bricks,
        drops: [],
        balls: [{ x: g.paddleX, y: PADDLE_Y - BALL_R - 1, vx: 0, vy: 0, id: nextId++ }],
        lives,
        score,
        broke,
        perfect,
        powers: { wide: 0, multi: 0, slow: 0 },
        serving: true,
        nextId: nextId + 1,
      });
      return;
    }

    // Level cleared.
    if (bricks.every((b) => !b.alive)) {
      const bonus = perfect ? 500 : 0;
      const level = g.level + 1;
      commit({
        ...newGame(level),
        score: score + bonus,
        lives,
        level,
        broke,
        status: "playing",
        serving: true,
        nextId: nextId + 1,
      });
      return;
    }

    commit({ ...g, bricks, balls, drops, score, broke, lives, perfect, powers, nextId });
  });

  const restart = useCallback(() => commit(newGame(0)), [commit]);

  useGameOverReport(runtime, isTerminal(game.status), () =>
    `Breakout over: ${game.score} points on level ${game.level + 1}, ${game.broke} bricks broken.`,
  );

  const tell = useCallback(() => {
    void share(`I scored ${game.score} at Breakout, reaching level ${game.level + 1}.`, `Breakout: ${game.broke} bricks broken.`);
  }, [share, game.score, game.level, game.broke]);

  const active = (Object.keys(game.powers) as Power[]).filter((k) => game.powers[k] > 0);

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Breakout"
        stats={[
          { label: "Score", value: game.score },
          { label: "Lives", value: game.lives },
          { label: "Level", value: game.level + 1 },
        ]}
        hint={topic ? `Level: ${topic}` : undefined}
      />

      <div className={s.fieldWrap}>
        <div
          ref={fieldRef}
          className={s.field}
          style={sv({ "--vw": VW, "--vh": VH })}
          onPointerMove={onPointer}
          onPointerDown={(e) => {
            onPointer(e);
            serve();
          }}
          role="img"
          aria-label={`Breakout, ${game.score} points, ${game.lives} lives`}
        >
          {game.bricks.map((b, i) =>
            b.alive ? (
              <div
                key={i}
                className={`${s.brick} ${s[`hp${b.hp}`]} ${b.hp < b.max ? s.cracked : ""}`}
                style={sv({ "--x": b.x, "--y": b.y, "--w": BRICK_W, "--h": BRICK_H })}
              />
            ) : null,
          )}

          {game.drops.map((d) => (
            <div key={d.id} className={`${s.drop} ${s[d.kind]}`} style={sv({ "--x": d.x, "--y": d.y })}>
              {d.kind === "wide" ? "W" : d.kind === "multi" ? "3" : "S"}
            </div>
          ))}

          {game.balls.map((b) => (
            <div key={b.id} className={s.ball} style={sv({ "--x": b.x, "--y": b.y, "--r": BALL_R })} />
          ))}

          <div
            className={s.paddle}
            style={sv({ "--x": game.paddleX, "--y": PADDLE_Y, "--w": paddleWidth(game), "--h": PADDLE_H })}
          />

          <Overlay
            status={game.status}
            title={game.status === "ready" ? "Breakout" : "Game over"}
            detail={
              game.status === "ready"
                ? "Tap or press space to serve. Where the ball hits the paddle decides its angle."
                : `${game.score} points, level ${game.level + 1}.`
            }
            action={game.status === "ready" ? "Serve" : "Play again"}
            onAction={game.status === "ready" ? serve : restart}
          />
        </div>
      </div>

      {active.length > 0 && (
        <p className={s.powerRow}>
          {active.map((k) => (
            <span key={k} className={`${s.powerChip} ${s[k]}`}>
              {k === "wide" ? "Wide paddle" : k === "multi" ? "Multi-ball" : "Slow ball"}
            </span>
          ))}
        </p>
      )}

      <DPad onDirection={onDirection} hide="vertical" />

      <ControlBar>
        <button className={`${ui.btn} ${ui.primary}`} onClick={serve} disabled={!game.serving || isTerminal(game.status)}>
          Serve
        </button>
        <button className={ui.btn} onClick={restart}>
          Restart
        </button>
        <button className={ui.btn} onClick={tell} disabled={!isTerminal(game.status)}>
          Tell the model
        </button>
      </ControlBar>

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
