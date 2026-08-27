/**
 * @file The Asteroids world: pure state and a pure step, with no React and no
 * drawing anywhere in it.
 *
 * Kept separate so the physics can be simulated headlessly. A game with
 * momentum, screen wrap and splitting rocks has plenty of ways to leak an
 * entity or wedge a wave, and none of them are visible by reading the code.
 *
 * Two decisions shape everything else.
 *
 * **Newtonian ship.** Thrust accelerates along the nose, nothing decelerates
 * you but drag, and the ship keeps its momentum through a turn. That is what
 * Asteroids is; a ship that moves where it points is a different, worse game.
 *
 * **Everything wraps.** Ship, rocks, bullets and saucers all leave one edge and
 * arrive at the opposite one, so wrapping is applied once in `wrap` rather than
 * remembered per entity type. Collisions have to respect it too, which is why
 * `apart` measures the shortest distance across the seam instead of the naive
 * one.
 */

export const W = 800;
export const H = 600;

export type Size = 1 | 2 | 3;

export interface Rock {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: Size;
  angle: number;
  spin: number;
  /** Per-vertex radius jitter, fixed at spawn so the outline stays put. */
  shape: number[];
}

export interface Bullet {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  /** Saucer bullets kill the player; the player's kill rocks and saucers. */
  hostile: boolean;
}

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
}

export type PowerKind = "triple" | "rapid" | "shield" | "bomb";

export interface Power {
  x: number;
  y: number;
  vx: number;
  vy: number;
  kind: PowerKind;
  life: number;
}

export interface Saucer {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Small saucers aim; large ones spray. */
  small: boolean;
  fireIn: number;
  turnIn: number;
}

export interface Ship {
  x: number;
  y: number;
  vx: number;
  vy: number;
  angle: number;
  /** Seconds of spawn protection remaining. */
  invuln: number;
  thrusting: boolean;
}

export interface Input {
  left: boolean;
  right: boolean;
  thrust: boolean;
  fire: boolean;
}

export type Status = "ready" | "playing" | "dying" | "over";

export type Event =
  | { kind: "shot" }
  | { kind: "rock"; size: Size }
  | { kind: "death" }
  | { kind: "power"; power: PowerKind }
  | { kind: "hyper" }
  | { kind: "bomb" }
  | { kind: "saucer" }
  | { kind: "wave"; wave: number };

export interface World {
  ship: Ship;
  rocks: Rock[];
  bullets: Bullet[];
  particles: Particle[];
  powers: Power[];
  saucer: Saucer | null;
  status: Status;
  wave: number;
  score: number;
  lives: number;
  /** Seconds until the next shot is allowed. */
  cooldown: number;
  /** Timed abilities, in seconds remaining. */
  triple: number;
  rapid: number;
  shield: number;
  /** Bombs are stock, not a timer. */
  bombs: number;
  /** Consumed by the step: one-shot requests from the player. */
  wantHyper: boolean;
  wantBomb: boolean;
  /** Pause between losing a ship and the next one. */
  respawnIn: number;
  saucerIn: number;
  /** Events the component turns into sound and flashes. */
  events: Event[];
}

/* ------------------------------------------------------------------ */
/* Tuning                                                             */
/* ------------------------------------------------------------------ */

const TURN = 3.5; // radians/s
const THRUST = 260; // units/s^2
const DRAG = 0.72; // fraction of speed kept per second
const MAX_SPEED = 340;

const BULLET_SPEED = 460;
const BULLET_LIFE = 1.25;
const FIRE_GAP = 0.26;
const RAPID_GAP = 0.1;
const SPREAD = 0.22; // radians between triple-shot barrels

const SHIP_R = 11;
const ROCK_R: Record<Size, number> = { 1: 15, 2: 27, 3: 46 };
const ROCK_SCORE: Record<Size, number> = { 1: 100, 2: 50, 3: 20 };
const ROCK_SPEED: Record<Size, number> = { 1: 112, 2: 78, 3: 52 };

const SPAWN_INVULN = 2.2;
const RESPAWN_PAUSE = 1.4;
const POWER_LIFE = 13;
const POWER_CHANCE = 0.14;
const POWER_SECONDS = 11;
const MAX_BOMBS = 3;

const SAUCER_MIN = 18;
const SAUCER_MAX = 34;
const SAUCER_SPEED = 116;
const SAUCER_R = 16;

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length)];

/** Wrap a position into the field. Applied to everything that moves. */
function wrap(e: { x: number; y: number }): void {
  if (e.x < 0) e.x += W;
  else if (e.x >= W) e.x -= W;
  if (e.y < 0) e.y += H;
  else if (e.y >= H) e.y -= H;
}

/**
 * Shortest distance between two points on a wrapping field.
 *
 * The naive distance is wrong here: a rock one unit off the left edge and a
 * ship one unit off the right edge are two units apart, not seven hundred and
 * ninety eight, and using the naive figure would let them pass through each
 * other at the seam.
 */
export function apart(ax: number, ay: number, bx: number, by: number): number {
  let dx = Math.abs(ax - bx);
  let dy = Math.abs(ay - by);
  if (dx > W / 2) dx = W - dx;
  if (dy > H / 2) dy = H - dy;
  return Math.hypot(dx, dy);
}

const newShip = (): Ship => ({
  x: W / 2,
  y: H / 2,
  vx: 0,
  vy: 0,
  angle: -Math.PI / 2,
  invuln: SPAWN_INVULN,
  thrusting: false,
});

/** A rock outline: a ring of vertices with a fixed random wobble. */
function rockShape(): number[] {
  const n = 9 + Math.floor(Math.random() * 4);
  return Array.from({ length: n }, () => rand(0.72, 1.16));
}

/**
 * Rocks for a wave, placed away from the ship.
 *
 * Spawning on top of the player would kill them for nothing, so candidates are
 * rejected until one is far enough off. The attempt cap stops the loop being
 * unbounded on a crowded field.
 */
export function spawnWave(w: World): void {
  const count = Math.min(11, 3 + w.wave);
  for (let i = 0; i < count; i++) {
    let x = 0;
    let y = 0;
    for (let tries = 0; tries < 40; tries++) {
      x = rand(0, W);
      y = rand(0, H);
      if (apart(x, y, w.ship.x, w.ship.y) > 170) break;
    }
    const dir = rand(0, Math.PI * 2);
    const speed = ROCK_SPEED[3] * rand(0.6, 1.25);
    w.rocks.push({
      x,
      y,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      size: 3,
      angle: rand(0, Math.PI * 2),
      spin: rand(-1.1, 1.1),
      shape: rockShape(),
    });
  }
  w.events.push({ kind: "wave", wave: w.wave });
}

/**
 * A fresh world. Deterministic on purpose: React StrictMode double-invokes
 * state initialisers, so a random opening field would differ between the two
 * passes. The first wave is spawned when the player starts.
 */
export function newWorld(): World {
  return {
    ship: newShip(),
    rocks: [],
    bullets: [],
    particles: [],
    powers: [],
    saucer: null,
    status: "ready",
    wave: 0,
    score: 0,
    lives: 3,
    cooldown: 0,
    triple: 0,
    rapid: 0,
    shield: 0,
    bombs: 1,
    wantHyper: false,
    wantBomb: false,
    respawnIn: 0,
    saucerIn: 24,
    events: [],
  };
}

export function startWorld(w: World): void {
  w.status = "playing";
  w.wave = 1;
  w.saucerIn = rand(SAUCER_MIN, SAUCER_MAX);
  spawnWave(w);
}

/** Add a particle, wrapped on the spot. */
function addParticle(w: World, x: number, y: number, vx: number, vy: number, life: number): void {
  const p = { x, y, vx, vy, life, max: life };
  wrap(p);
  w.particles.push(p);
}

function burst(w: World, x: number, y: number, n: number, speed: number): void {
  for (let i = 0; i < n; i++) {
    const dir = rand(0, Math.PI * 2);
    const s = speed * rand(0.25, 1);
    addParticle(w, x, y, Math.cos(dir) * s, Math.sin(dir) * s, rand(0.3, 0.85));
  }
}

/** Break a rock, or destroy it if it is already the smallest. */
function shatter(w: World, index: number): void {
  const rock = w.rocks[index];
  w.rocks.splice(index, 1);
  w.score += ROCK_SCORE[rock.size];
  w.events.push({ kind: "rock", size: rock.size });
  burst(w, rock.x, rock.y, rock.size * 5, 130);

  if (Math.random() < POWER_CHANCE) {
    w.powers.push({
      x: rock.x,
      y: rock.y,
      vx: rand(-26, 26),
      vy: rand(-26, 26),
      kind: pick(["triple", "rapid", "shield", "bomb"] as const),
      life: POWER_LIFE,
    });
  }

  if (rock.size === 1) return;
  const next = (rock.size - 1) as Size;
  const base = Math.atan2(rock.vy, rock.vx);
  for (const turn of [-0.62, 0.62]) {
    const dir = base + turn + rand(-0.2, 0.2);
    const speed = ROCK_SPEED[next] * rand(0.75, 1.3);
    w.rocks.push({
      x: rock.x,
      y: rock.y,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed,
      size: next,
      angle: rand(0, Math.PI * 2),
      spin: rand(-1.6, 1.6),
      shape: rockShape(),
    });
  }
}

function fire(w: World): void {
  if (w.cooldown > 0) return;
  w.cooldown = w.rapid > 0 ? RAPID_GAP : FIRE_GAP;
  const angles = w.triple > 0 ? [-SPREAD, 0, SPREAD] : [0];
  for (const off of angles) {
    const a = w.ship.angle + off;
    w.bullets.push({
      x: w.ship.x + Math.cos(a) * SHIP_R,
      y: w.ship.y + Math.sin(a) * SHIP_R,
      // Inheriting some ship velocity is what makes shooting while drifting
      // feel right rather than like the bullets come from somewhere else.
      vx: Math.cos(a) * BULLET_SPEED + w.ship.vx * 0.4,
      vy: Math.sin(a) * BULLET_SPEED + w.ship.vy * 0.4,
      life: BULLET_LIFE,
      hostile: false,
    });
  }
  w.events.push({ kind: "shot" });
}

/** Jump somewhere else on the field, the classic escape hatch. */
function hyperspace(w: World): void {
  let x = w.ship.x;
  let y = w.ship.y;
  for (let tries = 0; tries < 40; tries++) {
    x = rand(0, W);
    y = rand(0, H);
    if (w.rocks.every((r) => apart(x, y, r.x, r.y) > ROCK_R[r.size] + 46)) break;
  }
  burst(w, w.ship.x, w.ship.y, 12, 90);
  w.ship.x = x;
  w.ship.y = y;
  w.ship.vx = 0;
  w.ship.vy = 0;
  w.ship.invuln = Math.max(w.ship.invuln, 0.7);
  w.events.push({ kind: "hyper" });
}

/** Clear everything nearby, for when a wave has gone wrong. */
function bomb(w: World): void {
  if (w.bombs <= 0) return;
  w.bombs--;
  w.events.push({ kind: "bomb" });
  burst(w, w.ship.x, w.ship.y, 40, 260);
  for (let i = w.rocks.length - 1; i >= 0; i--) {
    if (apart(w.ship.x, w.ship.y, w.rocks[i].x, w.rocks[i].y) < 240) shatter(w, i);
  }
  if (w.saucer && apart(w.ship.x, w.ship.y, w.saucer.x, w.saucer.y) < 240) {
    w.score += w.saucer.small ? 1000 : 200;
    burst(w, w.saucer.x, w.saucer.y, 22, 180);
    w.saucer = null;
  }
  w.bullets = w.bullets.filter((b) => !b.hostile);
}

function killShip(w: World): void {
  // A shield is spent absorbing the hit rather than ignoring it.
  if (w.shield > 0) {
    w.shield = 0;
    burst(w, w.ship.x, w.ship.y, 18, 150);
    return;
  }
  if (w.ship.invuln > 0) return;

  burst(w, w.ship.x, w.ship.y, 26, 190);
  w.events.push({ kind: "death" });
  w.lives--;
  w.triple = 0;
  w.rapid = 0;
  if (w.lives <= 0) {
    w.status = "over";
  } else {
    w.status = "dying";
    w.respawnIn = RESPAWN_PAUSE;
  }
}

function spawnSaucer(w: World): void {
  // Small saucers are the dangerous ones, and they arrive more often later.
  const small = Math.random() < Math.min(0.65, 0.2 + w.wave * 0.07);
  const fromLeft = Math.random() < 0.5;
  w.saucer = {
    x: fromLeft ? -SAUCER_R : W + SAUCER_R,
    y: rand(60, H - 60),
    vx: (fromLeft ? 1 : -1) * SAUCER_SPEED,
    vy: rand(-30, 30),
    small,
    fireIn: rand(0.7, 1.5),
    turnIn: rand(0.6, 1.4),
  };
  w.events.push({ kind: "saucer" });
}

/**
 * Advance the world by `dt` seconds.
 *
 * `dt` is clamped by the caller, so a stalled frame cannot teleport anything.
 * Everything moves, then everything collides, then the wave is checked, in that
 * order: resolving collisions mid-movement would make the outcome depend on
 * iteration order.
 */
export function step(w: World, dt: number, input: Input): void {
  // Timers first, so an ability expiring this frame does so before it is used.
  w.cooldown = Math.max(0, w.cooldown - dt);
  w.triple = Math.max(0, w.triple - dt);
  w.rapid = Math.max(0, w.rapid - dt);
  w.shield = Math.max(0, w.shield - dt);

  for (const p of w.particles) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    wrap(p);
  }
  w.particles = w.particles.filter((p) => p.life > 0);

  if (w.status === "dying") {
    w.respawnIn -= dt;
    if (w.respawnIn <= 0) {
      w.ship = newShip();
      w.status = "playing";
    }
  }

  const alive = w.status === "playing";

  // ---- Ship ----
  if (alive) {
    const s = w.ship;
    s.invuln = Math.max(0, s.invuln - dt);
    if (input.left) s.angle -= TURN * dt;
    if (input.right) s.angle += TURN * dt;
    s.thrusting = input.thrust;
    if (input.thrust) {
      s.vx += Math.cos(s.angle) * THRUST * dt;
      s.vy += Math.sin(s.angle) * THRUST * dt;
      if (Math.random() < 0.5) {
        const back = s.angle + Math.PI;
        addParticle(
          w,
          s.x + Math.cos(back) * SHIP_R,
          s.y + Math.sin(back) * SHIP_R,
          Math.cos(back) * rand(60, 140) + s.vx,
          Math.sin(back) * rand(60, 140) + s.vy,
          0.3,
        );
      }
    }
    // Drag as a per-second fraction, so it is frame-rate independent.
    const keep = DRAG ** dt;
    s.vx *= keep;
    s.vy *= keep;
    const speed = Math.hypot(s.vx, s.vy);
    if (speed > MAX_SPEED) {
      s.vx = (s.vx / speed) * MAX_SPEED;
      s.vy = (s.vy / speed) * MAX_SPEED;
    }
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    wrap(s);

    if (w.wantHyper) hyperspace(w);
    if (w.wantBomb) bomb(w);
    if (input.fire) fire(w);
  }
  w.wantHyper = false;
  w.wantBomb = false;

  // ---- Rocks ----
  for (const r of w.rocks) {
    r.x += r.vx * dt;
    r.y += r.vy * dt;
    r.angle += r.spin * dt;
    wrap(r);
  }

  // ---- Bullets ----
  for (const b of w.bullets) {
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.life -= dt;
    wrap(b);
  }
  w.bullets = w.bullets.filter((b) => b.life > 0);

  // ---- Powerups ----
  for (const p of w.powers) {
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;
    wrap(p);
  }
  w.powers = w.powers.filter((p) => p.life > 0);

  // ---- Saucer ----
  if (w.saucer) {
    const u = w.saucer;
    u.x += u.vx * dt;
    u.y += u.vy * dt;
    u.turnIn -= dt;
    if (u.turnIn <= 0) {
      u.vy = rand(-40, 40);
      u.turnIn = rand(0.6, 1.6);
    }
    // Saucers wrap vertically but leave for good horizontally.
    if (u.y < 0) u.y += H;
    else if (u.y >= H) u.y -= H;
    if (u.x < -SAUCER_R * 2 || u.x > W + SAUCER_R * 2) {
      w.saucer = null;
    } else {
      u.fireIn -= dt;
      // Only once it is actually on the field. A saucer enters from off-screen,
      // and a bullet spawned out there would wrap on its first step and appear
      // shooting from the opposite edge.
      const onField = u.x > 0 && u.x < W;
      if (u.fireIn <= 0 && alive && onField) {
        u.fireIn = u.small ? rand(0.8, 1.5) : rand(1.1, 2.1);
        // A small saucer aims; a large one sprays.
        const aim = Math.atan2(w.ship.y - u.y, w.ship.x - u.x);
        const dir = u.small ? aim + rand(-0.12, 0.12) : rand(0, Math.PI * 2);
        w.bullets.push({
          x: u.x,
          y: u.y,
          vx: Math.cos(dir) * 300,
          vy: Math.sin(dir) * 300,
          life: 1.6,
          hostile: true,
        });
      }
    }
  } else if (alive) {
    w.saucerIn -= dt;
    if (w.saucerIn <= 0) {
      spawnSaucer(w);
      w.saucerIn = rand(SAUCER_MIN, SAUCER_MAX);
    }
  }

  // ---- Collisions ----
  // Player bullets against rocks, back to front so splicing is safe.
  for (let bi = w.bullets.length - 1; bi >= 0; bi--) {
    const b = w.bullets[bi];
    if (b.hostile) continue;
    let hit = false;
    for (let ri = w.rocks.length - 1; ri >= 0; ri--) {
      const r = w.rocks[ri];
      if (apart(b.x, b.y, r.x, r.y) > ROCK_R[r.size]) continue;
      shatter(w, ri);
      hit = true;
      break;
    }
    if (hit) {
      w.bullets.splice(bi, 1);
      continue;
    }
    if (w.saucer && apart(b.x, b.y, w.saucer.x, w.saucer.y) < SAUCER_R) {
      w.score += w.saucer.small ? 1000 : 200;
      burst(w, w.saucer.x, w.saucer.y, 22, 180);
      w.saucer = null;
      w.bullets.splice(bi, 1);
    }
  }

  if (w.status === "playing") {
    // Rocks against the ship.
    for (let ri = w.rocks.length - 1; ri >= 0; ri--) {
      const r = w.rocks[ri];
      if (apart(w.ship.x, w.ship.y, r.x, r.y) > ROCK_R[r.size] + SHIP_R) continue;
      const shielded = w.shield > 0;
      killShip(w);
      // A shield clears the rock it stopped. Bare spawn protection does not, or
      // a player could farm rocks by sitting still after respawning.
      if (shielded) shatter(w, ri);
      break;
    }
  }

  if (w.status === "playing") {
    // Saucer fire against the ship.
    for (let bi = w.bullets.length - 1; bi >= 0; bi--) {
      const b = w.bullets[bi];
      if (!b.hostile) continue;
      if (apart(b.x, b.y, w.ship.x, w.ship.y) > SHIP_R) continue;
      w.bullets.splice(bi, 1);
      killShip(w);
      break;
    }
  }

  if (w.status === "playing" && w.saucer) {
    if (apart(w.ship.x, w.ship.y, w.saucer.x, w.saucer.y) < SAUCER_R + SHIP_R) {
      killShip(w);
      burst(w, w.saucer.x, w.saucer.y, 22, 180);
      w.saucer = null;
    }
  }

  if (w.status === "playing") {
    for (let pi = w.powers.length - 1; pi >= 0; pi--) {
      const p = w.powers[pi];
      if (apart(w.ship.x, w.ship.y, p.x, p.y) > SHIP_R + 13) continue;
      w.powers.splice(pi, 1);
      if (p.kind === "bomb") w.bombs = Math.min(MAX_BOMBS, w.bombs + 1);
      else if (p.kind === "triple") w.triple = POWER_SECONDS;
      else if (p.kind === "rapid") w.rapid = POWER_SECONDS;
      else w.shield = POWER_SECONDS;
      w.events.push({ kind: "power", power: p.kind });
    }
  }

  // ---- Wave ----
  if (w.rocks.length === 0 && w.status === "playing") {
    w.wave++;
    // A moment of quiet, and a bomb back, before the next wave arrives.
    w.bombs = Math.min(MAX_BOMBS, w.bombs + 1);
    w.ship.invuln = Math.max(w.ship.invuln, 1.4);
    spawnWave(w);
  }
}

export const RADIUS = { ship: SHIP_R, rock: ROCK_R, saucer: SAUCER_R };
export const MAX_BOMB_STOCK = MAX_BOMBS;
export const POWER_LABEL: Record<PowerKind, string> = {
  triple: "Triple shot",
  rapid: "Rapid fire",
  shield: "Shield",
  bomb: "Bomb",
};
