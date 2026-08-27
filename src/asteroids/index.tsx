/**
 * @file Asteroids: the vector look, drawn on a canvas.
 *
 * Canvas rather than DOM nodes, which is the one place in this catalogue where
 * that is clearly right. Rocks are irregular spinning polygons and explosions
 * are dozens of short-lived sparks; expressing those as elements would mean
 * per-frame path rewrites on thirty nodes to get something a single stroked
 * path gives for free. The guide points at canvas for exactly this.
 *
 * The world is a pure module (`world.ts`) and this file only does three things:
 * collect input, advance the world, draw it. That split is what let the physics
 * be simulated headlessly before any of this existed, which is how two wrapping
 * bugs were found that no amount of reading would have shown.
 *
 * The canvas is sized in device pixels and scaled by the ratio, so lines are
 * crisp on a phone instead of soft. Drawing happens in world units, with one
 * transform applied up front.
 *
 * Controls are built for both, not ported from one to the other. A keyboard
 * plays it the arcade way. Touch needs three fingers' worth of simultaneous
 * input, which a drag cannot give, so it gets real on-screen buttons that
 * register on pointer down and release on pointer up, and several can be held
 * at once.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  StatusLine,
  isTerminal,
  useBest,
  useFrameLoop,
  useFullscreen,
  useGameOverReport,
  useShare,
  type GameStatus,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import {
  H,
  MAX_BOMB_STOCK,
  POWER_LABEL,
  RADIUS,
  W,
  newWorld,
  startWorld,
  step,
  type Input,
  type PowerKind,
  type World,
} from "./world";
import s from "./asteroids.module.css";

/**
 * The vector palette. Asteroids is a phosphor game and it commits to that
 * rather than following the host theme: white-on-white would not read, and the
 * glow is half of what makes the look. The chrome around the canvas still uses
 * host tokens.
 */
const INK = "#dbe4ff";
const ROCK = "#93a4d4";
const SHIP = "#b9a2ff";
const FLAME = "#ffb35c";
const SHOT = "#ffffff";
const HOSTILE = "#ff6b7a";
const SAUCER = "#5eead4";
const SPARK = "#ffd9a0";
const POWER_COLOUR: Record<PowerKind, string> = {
  triple: "#f472b6",
  rapid: "#facc15",
  shield: "#38bdf8",
  bomb: "#a3e635",
};
const POWER_GLYPH: Record<PowerKind, string> = { triple: "3", rapid: "R", shield: "S", bomb: "B" };

export default function Asteroids({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);

  const world = useRef<World>(newWorld());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const input = useRef<Input>({ left: false, right: false, thrust: false, fire: false });

  // React holds only what the chrome shows, and only when it changes.
  const [hud, setHud] = useState({
    score: 0,
    lives: 3,
    wave: 0,
    bombs: 1,
    triple: 0,
    rapid: 0,
    shield: 0,
  });
  const [status, setStatus] = useState<GameStatus>("ready");
  const [flash, setFlash] = useState("");
  const flashTimer = useRef<number | undefined>(undefined);

  const best = useBest(hud.score);

  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const announce = useCallback((text: string) => {
    setFlash(text);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(""), 1400);
  }, []);

  /* ---------------- Drawing ---------------- */

  /**
   * Size the backing store in device pixels. Without this the canvas is scaled
   * up from CSS pixels and every line looks soft, which for a game that is
   * nothing but lines is most of the picture.
   */
  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2.5);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
  }, []);

  useEffect(() => {
    resize();
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [resize]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const w = world.current;

    const scale = canvas.width / W;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.clearRect(0, 0, W, H);

    // Space, and a faint frame so the field's edge is visible.
    ctx.fillStyle = "#070a18";
    ctx.fillRect(0, 0, W, H);

    ctx.lineJoin = "round";
    ctx.lineCap = "round";

    /** Draw once per wrapped copy, so a shape straddling the seam is whole. */
    const around = (x: number, y: number, r: number, paint: () => void) => {
      const xs = [x];
      const ys = [y];
      if (x < r) xs.push(x + W);
      else if (x > W - r) xs.push(x - W);
      if (y < r) ys.push(y + H);
      else if (y > H - r) ys.push(y - H);
      for (const px of xs) {
        for (const py of ys) {
          ctx.save();
          ctx.translate(px, py);
          paint();
          ctx.restore();
        }
      }
    };

    // ---- Particles ----
    for (const p of w.particles) {
      const fade = Math.max(0, p.life / p.max);
      ctx.globalAlpha = fade;
      ctx.fillStyle = SPARK;
      ctx.fillRect(p.x - 1.2, p.y - 1.2, 2.4, 2.4);
    }
    ctx.globalAlpha = 1;

    // ---- Rocks ----
    ctx.strokeStyle = ROCK;
    ctx.lineWidth = 1.8;
    for (const r of w.rocks) {
      const radius = RADIUS.rock[r.size];
      around(r.x, r.y, radius, () => {
        ctx.rotate(r.angle);
        ctx.beginPath();
        r.shape.forEach((jitter, i) => {
          const a = (i / r.shape.length) * Math.PI * 2;
          const rr = radius * jitter;
          const px = Math.cos(a) * rr;
          const py = Math.sin(a) * rr;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.closePath();
        ctx.stroke();
      });
    }

    // ---- Powerups ----
    for (const p of w.powers) {
      // Blink out the last two seconds, so a pickup about to vanish says so.
      if (p.life < 2 && Math.floor(p.life * 8) % 2 === 0) continue;
      around(p.x, p.y, 14, () => {
        ctx.strokeStyle = POWER_COLOUR[p.kind];
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 11, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = POWER_COLOUR[p.kind];
        ctx.font = "bold 13px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(POWER_GLYPH[p.kind], 0, 1);
      });
    }

    // ---- Bullets ----
    for (const b of w.bullets) {
      ctx.fillStyle = b.hostile ? HOSTILE : SHOT;
      ctx.beginPath();
      ctx.arc(b.x, b.y, b.hostile ? 2.6 : 2.1, 0, Math.PI * 2);
      ctx.fill();
    }

    // ---- Saucer ----
    if (w.saucer) {
      const u = w.saucer;
      const k = u.small ? 0.72 : 1;
      ctx.strokeStyle = SAUCER;
      ctx.lineWidth = 1.8;
      around(u.x, u.y, RADIUS.saucer, () => {
        ctx.scale(k, k);
        ctx.beginPath();
        ctx.moveTo(-16, 0);
        ctx.lineTo(-7, -6);
        ctx.lineTo(7, -6);
        ctx.lineTo(16, 0);
        ctx.lineTo(7, 6);
        ctx.lineTo(-7, 6);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-7, -6);
        ctx.lineTo(-4, -12);
        ctx.lineTo(4, -12);
        ctx.lineTo(7, -6);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-16, 0);
        ctx.lineTo(16, 0);
        ctx.stroke();
      });
    }

    // ---- Ship ----
    if (w.status === "playing") {
      const ship = w.ship;
      // Blink while spawn protection lasts, so the state is legible.
      const blinking = ship.invuln > 0 && Math.floor(ship.invuln * 10) % 2 === 0;
      if (!blinking) {
        around(ship.x, ship.y, 26, () => {
          ctx.rotate(ship.angle);

          if (w.shield > 0) {
            ctx.strokeStyle = POWER_COLOUR.shield;
            ctx.globalAlpha = w.shield < 2.5 ? 0.4 + 0.4 * Math.abs(Math.sin(w.shield * 8)) : 0.75;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(0, 0, 19, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }

          if (ship.thrusting) {
            ctx.strokeStyle = FLAME;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(-7, -4);
            ctx.lineTo(-15 - Math.random() * 5, 0);
            ctx.lineTo(-7, 4);
            ctx.stroke();
          }

          ctx.strokeStyle = SHIP;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(14, 0);
          ctx.lineTo(-9, -9);
          ctx.lineTo(-5, 0);
          ctx.lineTo(-9, 9);
          ctx.closePath();
          ctx.stroke();
        });
      }
    }

    // ---- Wave number, faint, behind everything the player needs ----
    if (w.status !== "ready") {
      ctx.fillStyle = INK;
      ctx.globalAlpha = 0.14;
      ctx.font = "bold 120px ui-monospace, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(w.wave), W / 2, H / 2);
      ctx.globalAlpha = 1;
    }
  }, []);

  /* ---------------- Loop ---------------- */

  useFrameLoop(status === "playing", (dtMs) => {
    const w = world.current;
    w.events.length = 0;
    // The shell clamps dtMs to 250, and the world assumes that.
    step(w, dtMs / 1000, input.current);

    for (const e of w.events) {
      if (e.kind === "power") announce(POWER_LABEL[e.power]);
      else if (e.kind === "wave" && e.wave > 1) announce(`Wave ${e.wave}`);
      else if (e.kind === "bomb") announce("Bomb");
      else if (e.kind === "saucer") announce("Saucer");
    }

    setHud((prev) => {
      const next = {
        score: w.score,
        lives: w.lives,
        wave: w.wave,
        bombs: w.bombs,
        triple: Math.ceil(w.triple),
        rapid: Math.ceil(w.rapid),
        shield: Math.ceil(w.shield),
      };
      const same =
        prev.score === next.score &&
        prev.lives === next.lives &&
        prev.wave === next.wave &&
        prev.bombs === next.bombs &&
        prev.triple === next.triple &&
        prev.rapid === next.rapid &&
        prev.shield === next.shield;
      return same ? prev : next;
    });

    if (w.status === "over") setStatus("over");
    draw();
  });

  // Draw once whenever the game is not running, so the field is never blank.
  useEffect(() => {
    draw();
  }, [draw, status]);

  const begin = useCallback(() => {
    const w = newWorld();
    startWorld(w);
    world.current = w;
    input.current = { left: false, right: false, thrust: false, fire: false };
    setHud({ score: 0, lives: 3, wave: 1, bombs: 1, triple: 0, rapid: 0, shield: 0 });
    setStatus("playing");
    draw();
  }, [draw]);

  /* ---------------- Keyboard ---------------- */

  useEffect(() => {
    const KEYS: Record<string, keyof Input> = {
      arrowleft: "left",
      a: "left",
      arrowright: "right",
      d: "right",
      arrowup: "thrust",
      w: "thrust",
      " ": "fire",
    };
    const isField = (t: EventTarget | null) => {
      const tag = (t as HTMLElement | null)?.tagName;
      return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    };

    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isField(e.target)) return;
      const k = e.key.toLowerCase();
      const held = KEYS[k];
      if (held) {
        e.preventDefault();
        input.current[held] = true;
        return;
      }
      if (k === "h" || k === "shift") {
        e.preventDefault();
        world.current.wantHyper = true;
      } else if (k === "b") {
        e.preventDefault();
        world.current.wantBomb = true;
      } else if (k === "enter" && status !== "playing") {
        e.preventDefault();
        begin();
      }
    };
    const up = (e: KeyboardEvent) => {
      const held = KEYS[e.key.toLowerCase()];
      if (held) input.current[held] = false;
    };
    // Losing focus mid-thrust would leave the ship accelerating forever.
    const panic = () => {
      input.current = { left: false, right: false, thrust: false, fire: false };
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", panic);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", panic);
    };
  }, [status, begin]);

  /* ---------------- Touch ---------------- */

  /**
   * A hold button. Several can be held at once, which is the whole reason these
   * exist rather than a drag: turning, thrusting and firing happen together.
   */
  const holdProps = (key: keyof Input) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      input.current[key] = true;
    },
    onPointerUp: () => {
      input.current[key] = false;
    },
    onPointerLeave: () => {
      input.current[key] = false;
    },
    onPointerCancel: () => {
      input.current[key] = false;
    },
  });

  useGameOverReport(runtime, isTerminal(status), () =>
    `Asteroids over on wave ${hud.wave}: ${hud.score} points.`,
  );

  const tell = useCallback(() => {
    void share(`I scored ${hud.score} at Asteroids, reaching wave ${hud.wave}.`, `Asteroids: best ${best}.`);
  }, [share, hud.score, hud.wave, best]);

  const abilities: [string, number, PowerKind][] = [
    ["Triple", hud.triple, "triple"],
    ["Rapid", hud.rapid, "rapid"],
    ["Shield", hud.shield, "shield"],
  ];

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Asteroids"
        stats={[
          { label: "Score", value: hud.score },
          { label: "Ships", value: hud.lives },
          { label: "Wave", value: hud.wave },
          { label: "Best", value: best },
        ]}
        hint={status === "ready" ? "Turn, thrust, and do not stop moving" : undefined}
      />

      <div className={s.screenWrap}>
        <canvas
          ref={canvasRef}
          className={s.screen}
          role="img"
          aria-label={`Asteroids. ${hud.score} points, wave ${hud.wave}, ${hud.lives} ships left.`}
        />

        {flash && <span className={s.flash}>{flash}</span>}

        <Overlay
          status={status}
          title={status === "ready" ? "Asteroids" : "Ship lost"}
          detail={
            status === "ready"
              ? "Blast the rocks. They break into smaller, faster ones. Pick up what they drop."
              : `${hud.score} points, wave ${hud.wave}.`
          }
          action={status === "ready" ? "Launch" : "Launch again"}
          onAction={begin}
        />
      </div>

      {/* Ability readout, only while something is active, so it costs no room
          the rest of the time. */}
      {(hud.triple > 0 || hud.rapid > 0 || hud.shield > 0 || hud.bombs > 0) && (
        <p className={s.powerRow}>
          {abilities
            .filter(([, left]) => left > 0)
            .map(([label, left, kind]) => (
              <span key={label} className={s.chip} style={{ borderColor: POWER_COLOUR[kind], color: POWER_COLOUR[kind] }}>
                {label} {left}s
              </span>
            ))}
          {hud.bombs > 0 && (
            <span className={s.chip} style={{ borderColor: POWER_COLOUR.bomb, color: POWER_COLOUR.bomb }}>
              Bombs {hud.bombs}/{MAX_BOMB_STOCK}
            </span>
          )}
        </p>
      )}

      {/* Touch controls: left thumb steers and thrusts, right thumb fires. */}
      <div className={s.pad}>
        <div className={s.padLeft}>
          <button className={s.padBtn} aria-label="Turn left" {...holdProps("left")}>
            &#9664;
          </button>
          <button className={`${s.padBtn} ${s.thrust}`} aria-label="Thrust" {...holdProps("thrust")}>
            &#9650;
          </button>
          <button className={s.padBtn} aria-label="Turn right" {...holdProps("right")}>
            &#9654;
          </button>
        </div>
        <div className={s.padRight}>
          <button
            className={s.smallBtn}
            aria-label="Hyperspace"
            onPointerDown={() => {
              world.current.wantHyper = true;
            }}
          >
            Jump
          </button>
          <button
            className={s.smallBtn}
            aria-label="Bomb"
            disabled={hud.bombs <= 0}
            onPointerDown={() => {
              world.current.wantBomb = true;
            }}
          >
            Bomb
          </button>
          <button className={`${s.padBtn} ${s.fire}`} aria-label="Fire" {...holdProps("fire")}>
            &#9679;
          </button>
        </div>
      </div>

      <ControlBar>
        <button className={ui.btn} onClick={begin}>
          Restart
        </button>
        <button className={ui.btn} onClick={tell} disabled={!isTerminal(status)}>
          Tell the model
        </button>
      </ControlBar>

      <Notice>
        Arrows or A and D turn, up or W thrusts, space fires, H jumps, B drops a bomb. Rocks break into
        smaller and faster ones, so clearing a big one makes things worse before it makes them better.
      </Notice>

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
