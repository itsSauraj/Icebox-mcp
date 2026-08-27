/**
 * @file Hot Air Balloon: hold to rise, collect bubbles, miss the spikes.
 *
 * A version of the offline mini-game the Google Play Store shows when it cannot
 * reach the network, the way Chrome shows its dinosaur. Balloon drifting left to
 * right, bubbles for score, platforms of spikes to avoid, and two pickups: a
 * magnet that drags bubbles in and a shield that makes spikes harmless for a
 * few seconds.
 *
 * The control is what separates this from Flappy, which this catalogue already
 * has. Flappy is an impulse: each tap is a fixed kick. A balloon is sustained
 * lift, so holding accelerates upward and releasing lets gravity take over.
 * Height is something you settle into rather than something you fight.
 *
 * Everything lives on a fixed virtual field scaled by CSS, and motion
 * integrates against elapsed milliseconds, so the flight is identical at 60Hz
 * and 120Hz and at any rendered size.
 *
 * Entities come from fixed-size pools rather than arrays that grow. That keeps
 * one DOM node and one ref per slot for the life of the game, which is what
 * lets the frame loop write transforms straight to the DOM instead of
 * re-rendering React sixty times a second.
 *
 * Obstacles are spaced further apart in x than they are wide, so only ever one
 * sits in the balloon's column, and their height is capped well below the field
 * height. Every gap is therefore passable by construction rather than by luck.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { randInt } from "../lib/rng";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  StatusLine,
  clamp,
  isTerminal,
  sv,
  useBest,
  useFrameLoop,
  useFullscreen,
  useGameOverReport,
  useShare,
  type GameStatus,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./balloon.module.css";

/** Virtual field. Every number below is in these units. */
const VW = 360;
const VH = 260;

const BALLOON_X = 96;
const BALLOON_R = 13; // collision radius, a little inside the drawn envelope

const LIFT = -1000; // units/s^2 while held
const GRAVITY = 420; // units/s^2 always
const MAX_RISE = -250; // units/s
const MAX_FALL = 260; // units/s

/**
 * Scroll speed and lift are tuned against each other, not chosen separately.
 * The balloon has to be able to cross the full height of the field in less time
 * than one platform spacing takes to pass at top speed, or a gap on the far
 * side becomes unreachable through no fault of the player. Measured: a
 * full-height climb takes about 1.1s against 1.25s between platforms.
 */
const SCROLL_START = 96; // units/s
const SCROLL_MAX = 160;
const SCROLL_PER_BUBBLE = 1.4;

/** Obstacles are spaced wider than they are tall is irrelevant; what matters is
 *  that spacing exceeds width, so two never share the balloon's column. */
const OBSTACLES = 4;
const OB_SPACING = 200;
const OB_W_MIN = 34;
const OB_W_MAX = 62;
const OB_H_MIN = 52;
/** Capped so the remaining gap always clears the balloon several times over. */
const OB_H_MAX = 132;

const BUBBLES = 28;
const BUBBLE_R = 6;
const MAGNET_R = 58;

const POWERUPS = 2;
const POWER_MS = 6000;
const POWER_R = 9;

type Power = "magnet" | "shield";

interface Obstacle {
  x: number;
  w: number;
  h: number;
  from: "top" | "bottom";
  live: boolean;
}

interface Bubble {
  x: number;
  y: number;
  live: boolean;
}

interface Pickup {
  x: number;
  y: number;
  kind: Power;
  live: boolean;
}

type Phase = "ready" | "playing" | "over";

interface World {
  y: number;
  vy: number;
  holding: boolean;
  scroll: number;
  /** How far the next obstacle still is, so spacing does not drift. */
  nextObAt: number;
  obstacles: Obstacle[];
  bubbles: Bubble[];
  pickups: Pickup[];
  magnetMs: number;
  shieldMs: number;
  phase: Phase;
  collected: number;
  /** Distance travelled, in field widths, shown as a secondary stat. */
  distance: number;
}

/**
 * A deterministic opening world. StrictMode double-invokes state initialisers,
 * so nothing here may be random: the first obstacles and bubbles are placed off
 * screen at fixed spots and only reseeded once the player starts.
 */
function newWorld(): World {
  return {
    y: VH / 2,
    vy: 0,
    holding: false,
    scroll: SCROLL_START,
    nextObAt: VW + 80,
    obstacles: Array.from({ length: OBSTACLES }, () => ({
      x: -999,
      w: OB_W_MIN,
      h: OB_H_MIN,
      from: "bottom" as const,
      live: false,
    })),
    bubbles: Array.from({ length: BUBBLES }, () => ({ x: -999, y: VH / 2, live: false })),
    pickups: Array.from({ length: POWERUPS }, () => ({
      x: -999,
      y: VH / 2,
      kind: "magnet" as Power,
      live: false,
    })),
    magnetMs: 0,
    shieldMs: 0,
    phase: "ready",
    collected: 0,
    distance: 0,
  };
}

/** The vertical band an obstacle occupies. */
const obstacleBand = (o: Obstacle) =>
  o.from === "top" ? { top: 0, bottom: o.h } : { top: VH - o.h, bottom: VH };

/** Circle against axis-aligned rectangle, the only collision shape here. */
function hitsRect(cx: number, cy: number, r: number, x: number, y: number, w: number, h: number) {
  const nx = clamp(cx, x, x + w);
  const ny = clamp(cy, y, y + h);
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy <= r * r;
}

export default function Balloon({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);

  const [phase, setPhase] = useState<Phase>("ready");
  const [score, setScore] = useState(0);
  const [magnet, setMagnet] = useState(false);
  const [shield, setShield] = useState(false);

  const w = useRef<World>(newWorld());
  const fieldEl = useRef<HTMLDivElement>(null);
  const worldEl = useRef<HTMLDivElement>(null);
  const balloonEl = useRef<HTMLDivElement>(null);
  const obEls = useRef<(HTMLDivElement | null)[]>([]);
  const bubbleEls = useRef<(HTMLDivElement | null)[]>([]);
  const pickupEls = useRef<(HTMLDivElement | null)[]>([]);

  const best = useBest(score);

  /** Push the world into the DOM. No React work per frame. */
  const paint = useCallback(() => {
    const g = w.current;

    if (balloonEl.current) {
      // Tilt with vertical speed: the envelope leans into a climb.
      const tilt = clamp((g.vy / MAX_FALL) * 14, -14, 14);
      balloonEl.current.style.transform = `translate(${BALLOON_X}px, ${g.y}px) rotate(${tilt}deg)`;
    }

    g.obstacles.forEach((o, i) => {
      const el = obEls.current[i];
      if (!el) return;
      el.style.display = o.live ? "block" : "none";
      if (!o.live) return;
      const band = obstacleBand(o);
      el.style.transform = `translate(${o.x}px, ${band.top}px)`;
      el.style.width = `${o.w}px`;
      el.style.height = `${o.h}px`;
      el.dataset.from = o.from;
    });

    g.bubbles.forEach((b, i) => {
      const el = bubbleEls.current[i];
      if (!el) return;
      el.style.display = b.live ? "block" : "none";
      if (b.live) el.style.transform = `translate(${b.x}px, ${b.y}px)`;
    });

    g.pickups.forEach((p, i) => {
      const el = pickupEls.current[i];
      if (!el) return;
      el.style.display = p.live ? "block" : "none";
      if (!p.live) return;
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      el.dataset.kind = p.kind;
    });
  }, []);

  /**
   * The whole scene is drawn in virtual pixels and the world layer is scaled to
   * whatever width the host gives us. Scaling one parent rather than converting
   * every coordinate keeps the physics numbers and the drawing numbers the same,
   * and it avoids the trap that `transform` and the `scale` property do not
   * compose the way the naive version assumed.
   */
  useEffect(() => {
    const field = fieldEl.current;
    const world = worldEl.current;
    if (!field || !world) return;
    const fit = () => {
      world.style.transform = `scale(${field.clientWidth / VW})`;
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(field);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    paint();
  }, [paint, phase]);

  const reset = useCallback(() => {
    w.current = newWorld();
    setScore(0);
    setMagnet(false);
    setShield(false);
    setPhase("ready");
    paint();
  }, [paint]);

  const start = useCallback(() => {
    const g = w.current;
    if (g.phase === "over") {
      reset();
      return;
    }
    if (g.phase === "ready") {
      g.phase = "playing";
      setPhase("playing");
    }
    g.holding = true;
  }, [reset]);

  const release = useCallback(() => {
    w.current.holding = false;
  }, []);

  // Hold to rise: pointer down and key down start lift, coming up ends it.
  useEffect(() => {
    const isControl = (t: EventTarget | null) => {
      const tag = (t as HTMLElement | null)?.tagName;
      return tag === "BUTTON" || tag === "INPUT" || tag === "SELECT";
    };
    const down = (e: PointerEvent) => {
      if (isControl(e.target)) return;
      e.preventDefault();
      start();
    };
    const up = () => release();
    const keyDown = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "ArrowUp" && e.key !== "w" && e.key !== "Enter") return;
      if (isControl(e.target)) return;
      e.preventDefault();
      if (e.repeat) return;
      start();
    };
    const keyUp = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "ArrowUp" && e.key !== "w" && e.key !== "Enter") return;
      release();
    };

    window.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    // Losing the window mid-hold would otherwise leave the balloon climbing.
    window.addEventListener("blur", up);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", up);
    };
  }, [start, release]);

  /** Place one obstacle plus the bubbles and pickup that ride alongside it. */
  const spawn = useCallback((atX: number) => {
    const g = w.current;
    const slot = g.obstacles.find((o) => !o.live);
    if (!slot) return;

    const from: "top" | "bottom" = randInt(0, 1) === 0 ? "top" : "bottom";
    // Height grows with the scroll speed, so the squeeze tightens over time.
    const ramp = (g.scroll - SCROLL_START) / (SCROLL_MAX - SCROLL_START);
    const hMax = Math.round(OB_H_MIN + (OB_H_MAX - OB_H_MIN) * clamp(ramp, 0, 1));
    slot.x = atX;
    slot.w = randInt(OB_W_MIN, OB_W_MAX);
    slot.h = randInt(OB_H_MIN, Math.max(OB_H_MIN, hMax));
    slot.from = from;
    slot.live = true;

    // Bubbles sit in the gap the obstacle leaves, which is what makes taking
    // them a real choice rather than free score.
    const band = obstacleBand(slot);
    const gapTop = from === "top" ? band.bottom + BALLOON_R : BALLOON_R * 2;
    const gapBottom = from === "top" ? VH - BALLOON_R * 2 : band.top - BALLOON_R;
    const count = randInt(2, 4);
    for (let k = 0; k < count; k++) {
      const b = g.bubbles.find((x) => !x.live);
      if (!b) break;
      b.x = atX + slot.w / 2 + (k - (count - 1) / 2) * 22;
      b.y = clamp(randInt(Math.round(gapTop), Math.round(gapBottom)), BUBBLE_R, VH - BUBBLE_R);
      b.live = true;
    }

    // A pickup now and then, never two at once.
    if (randInt(1, 4) === 1 && !g.pickups.some((p) => p.live)) {
      const p = g.pickups.find((x) => !x.live);
      if (p) {
        p.x = atX + slot.w + 60;
        p.y = randInt(Math.round(gapTop), Math.round(gapBottom));
        p.kind = randInt(0, 1) === 0 ? "magnet" : "shield";
        p.live = true;
      }
    }
  }, []);

  useFrameLoop(phase === "playing", (dtMs) => {
    const g = w.current;
    if (g.phase !== "playing") return;
    const dt = dtMs / 1000;

    // ---- Balloon ----
    const accel = (g.holding ? LIFT : 0) + GRAVITY;
    g.vy = clamp(g.vy + accel * dt, MAX_RISE, MAX_FALL);
    g.y += g.vy * dt;

    // The ceiling and the floor are hard, shield or not: they are the frame.
    if (g.y < BALLOON_R) {
      g.y = BALLOON_R;
      g.vy = 0;
    }
    if (g.y > VH - BALLOON_R) {
      g.y = VH - BALLOON_R;
      g.vy = 0;
      g.phase = "over";
      setPhase("over");
      paint();
      return;
    }

    // ---- World scroll ----
    const move = g.scroll * dt;
    g.distance += move / VW;

    for (const o of g.obstacles) {
      if (!o.live) continue;
      o.x -= move;
      if (o.x + o.w < -20) o.live = false;
    }
    for (const b of g.bubbles) {
      if (!b.live) continue;
      b.x -= move;
      if (b.x < -20) b.live = false;
    }
    for (const p of g.pickups) {
      if (!p.live) continue;
      p.x -= move;
      if (p.x < -20) p.live = false;
    }

    g.nextObAt -= move;
    if (g.nextObAt <= 0) {
      spawn(VW + 30);
      g.nextObAt = OB_SPACING;
    }

    // ---- Powerup timers ----
    if (g.magnetMs > 0) {
      g.magnetMs -= dtMs;
      if (g.magnetMs <= 0) setMagnet(false);
    }
    if (g.shieldMs > 0) {
      g.shieldMs -= dtMs;
      if (g.shieldMs <= 0) setShield(false);
    }

    // ---- Bubbles ----
    let gained = 0;
    for (const b of g.bubbles) {
      if (!b.live) continue;
      if (g.magnetMs > 0) {
        // Drag toward the balloon rather than snapping, so the pull reads.
        const dx = BALLOON_X - b.x;
        const dy = g.y - b.y;
        const d = Math.hypot(dx, dy);
        if (d < MAGNET_R && d > 0.001) {
          const pull = 190 * dt;
          b.x += (dx / d) * pull;
          b.y += (dy / d) * pull;
        }
      }
      const dx = b.x - BALLOON_X;
      const dy = b.y - g.y;
      if (dx * dx + dy * dy <= (BALLOON_R + BUBBLE_R) ** 2) {
        b.live = false;
        gained++;
      }
    }
    if (gained) {
      g.collected += gained;
      setScore(g.collected);
      g.scroll = Math.min(SCROLL_MAX, g.scroll + SCROLL_PER_BUBBLE * gained);
    }

    // ---- Pickups ----
    for (const p of g.pickups) {
      if (!p.live) continue;
      const dx = p.x - BALLOON_X;
      const dy = p.y - g.y;
      if (dx * dx + dy * dy > (BALLOON_R + POWER_R) ** 2) continue;
      p.live = false;
      if (p.kind === "magnet") {
        g.magnetMs = POWER_MS;
        setMagnet(true);
      } else {
        g.shieldMs = POWER_MS;
        setShield(true);
      }
    }

    // ---- Spikes ----
    if (g.shieldMs <= 0) {
      for (const o of g.obstacles) {
        if (!o.live) continue;
        const band = obstacleBand(o);
        if (!hitsRect(BALLOON_X, g.y, BALLOON_R, o.x, band.top, o.w, o.h)) continue;
        g.phase = "over";
        setPhase("over");
        paint();
        return;
      }
    }

    paint();
  });

  useGameOverReport(runtime, phase === "over", () =>
    `Hot Air Balloon over: ${w.current.collected} bubbles over ${w.current.distance.toFixed(1)} screens.`,
  );

  const tell = useCallback(() => {
    void share(
      `I collected ${score} bubbles in Hot Air Balloon.`,
      `Hot Air Balloon: ${w.current.distance.toFixed(1)} screens flown.`,
    );
  }, [share, score]);

  const status: GameStatus = phase === "over" ? "over" : phase === "ready" ? "ready" : "playing";

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Hot Air Balloon"
        stats={[
          { label: "Bubbles", value: score },
          { label: "Best", value: best },
        ]}
        hint={phase === "playing" ? undefined : "Hold to rise, let go to fall"}
      />

      <div className={s.fieldWrap} style={sv({ "--vw": VW, "--vh": VH })}>
        <div
          ref={fieldEl}
          className={s.field}
          role="img"
          aria-label={`Hot Air Balloon. ${score} bubbles collected.`}
        >
          <div ref={worldEl} className={s.world} style={sv({ "--vw": VW, "--vh": VH })}>
          <div className={s.hills} aria-hidden="true" />
          <div className={s.ground} aria-hidden="true" />

          {Array.from({ length: OBSTACLES }, (_, i) => (
            <div
              key={i}
              ref={(el) => {
                obEls.current[i] = el;
              }}
              className={s.spikes}
              aria-hidden="true"
            />
          ))}

          {Array.from({ length: BUBBLES }, (_, i) => (
            <div
              key={i}
              ref={(el) => {
                bubbleEls.current[i] = el;
              }}
              className={s.bubble}
              aria-hidden="true"
            />
          ))}

          {Array.from({ length: POWERUPS }, (_, i) => (
            <div
              key={i}
              ref={(el) => {
                pickupEls.current[i] = el;
              }}
              className={s.pickup}
              aria-hidden="true"
            />
          ))}

          <div ref={balloonEl} className={`${s.balloon} ${shield ? s.shielded : ""}`} aria-hidden="true">
            <BalloonSprite />
          </div>
          </div>

          <Overlay
            status={status}
            title={phase === "ready" ? "Hot Air Balloon" : "Down you go"}
            detail={
              phase === "ready"
                ? "Hold anywhere to rise. Collect bubbles, keep off the spikes."
                : `${score} bubbles over ${w.current.distance.toFixed(1)} screens.`
            }
            action={phase === "ready" ? "Fly" : "Fly again"}
            onAction={() => {
              if (phase === "over") reset();
              else {
                w.current.phase = "playing";
                setPhase("playing");
              }
            }}
          />
        </div>
      </div>

      {(magnet || shield) && (
        <p className={s.powerRow}>
          {magnet && <span className={`${s.powerChip} ${s.magnetChip}`}>Magnet</span>}
          {shield && <span className={`${s.powerChip} ${s.shieldChip}`}>Shield</span>}
        </p>
      )}

      <ControlBar>
        <button
          className={`${ui.btn} ${ui.primary}`}
          onPointerDown={start}
          onPointerUp={release}
          onPointerLeave={release}
        >
          Hold to rise
        </button>
        <button className={ui.btn} onClick={reset}>
          Restart
        </button>
        <button className={ui.btn} onClick={tell} disabled={!isTerminal(status)}>
          Tell the model
        </button>
      </ControlBar>

      <Notice>Space, up arrow or a held tap lifts. The magnet drags bubbles in; the shield ignores spikes.</Notice>

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}

/** Envelope, basket and two ropes. Lo-fi on purpose, as the original is. */
function BalloonSprite() {
  return (
    <svg viewBox="0 0 32 40" className={s.balloonSvg} aria-hidden="true">
      <path
        className={s.envelope}
        d="M16 1c7.2 0 13 5.4 13 12 0 5.6-4.7 10.7-9.2 14.3h-7.6C7.7 23.7 3 18.6 3 13 3 6.4 8.8 1 16 1z"
      />
      <path className={s.seam} d="M16 1v26.3M6.2 8.6h19.6M4.4 17.4h23.2" />
      <path className={s.rope} d="M12.4 27.6l1.4 3.4M19.6 27.6l-1.4 3.4" />
      <rect className={s.basket} x="12.4" y="30.6" width="7.2" height="5.6" rx="1.2" />
    </svg>
  );
}
