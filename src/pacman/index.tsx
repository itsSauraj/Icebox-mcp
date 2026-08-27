/**
 * @file Pac-Man: a maze, 187 pellets, and four ghosts that each hunt
 * differently.
 *
 * Movement is grid-exact rather than free-floating. Every mover holds an
 * integer cell plus a progress value in [0, 1) toward the next cell in its
 * direction, and a frame advances that progress, stepping cell by cell when it
 * overflows. Turning can therefore only happen on a cell boundary, which is how
 * the arcade behaves, and it means a fast frame can never carry anything
 * through a wall: the loop consumes the step one cell at a time.
 *
 * The ghosts are the game. Each picks, at every cell it enters, the legal
 * direction that minimises straight-line distance to its own target tile, never
 * reversing. That single rule plus four different targets is what produces the
 * arcade's behaviour, and it is worth stating what each target is:
 *
 *  - Blinky aims at Pac-Man, so he pursues.
 *  - Pinky aims four tiles ahead of Pac-Man, so he cuts corners and ambushes.
 *  - Inky aims at the point found by doubling the vector from Blinky to two
 *    tiles ahead of Pac-Man, so he swings wide and is hard to read.
 *  - Clyde aims at Pac-Man while far away and at his own corner once within
 *    eight tiles, so he breaks off just as he gets close.
 *
 * Scatter and chase alternate on a timer; a power pellet overrides both with
 * frightened, where ghosts pick randomly and can be eaten for a doubling chain.
 *
 * Rendering splits by how often things change. The walls never move, so they
 * are memoised. Pellets change only when one is eaten. The five movers change
 * every frame, so the loop writes their transforms straight to the DOM through
 * refs rather than re-rendering React sixty times a second.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randInt } from "../lib/rng";
import {
  ControlBar,
  DPad,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  StatusLine,
  isTerminal,
  seedString,
  sv,
  useBest,
  useDirectionKeys,
  useFrameLoop,
  useFullscreen,
  useGameOverReport,
  useKeys,
  useSeed,
  useShare,
  useSwipe,
  type Direction,
  type GameStatus,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./pacman.module.css";

/**
 * The maze. `#` wall, `.` pellet, `o` power pellet, `-` the ghost house door,
 * `G` a house slot, `P` Pac-Man's start, a space a cell nothing may enter.
 *
 * Validated before it shipped: 19x21, left-right symmetric, 183 pellets and 4
 * power pellets with every one reachable from the start, no walkable-but-empty
 * cells, and the door connecting the house to the maze. Row 9 has open ends,
 * which is the tunnel: movers leaving one side arrive at the other.
 */
const MAZE = [
  "###################",
  "#........#........#",
  "#o##.###.#.###.##o#",
  "#.................#",
  "#.##.##.###.##.##.#",
  "#....#.......#....#",
  "####.#.#####.#.####",
  "   #.#.......#.#   ",
  "####.#.##-##.#.####",
  ".......#GGG#.......",
  "####.#.#####.#.####",
  "   #.#.......#.#   ",
  "####.#.#####.#.####",
  "#........#........#",
  "#.##.###.#.###.##.#",
  "#o.......P.......o#",
  "##.#.#.#####.#.#.##",
  "#....#...#...#....#",
  "#.######.#.######.#",
  "#.................#",
  "###################",
];

const COLS = MAZE[0].length;
const ROWS = MAZE.length;

type Dir = Direction;
const DELTA: Record<Dir, { dc: number; dr: number }> = {
  up: { dc: 0, dr: -1 },
  down: { dc: 0, dr: 1 },
  left: { dc: -1, dr: 0 },
  right: { dc: 1, dr: 0 },
};
const OPPOSITE: Record<Dir, Dir> = { up: "down", down: "up", left: "right", right: "left" };
const DIRS: Dir[] = ["up", "left", "down", "right"];

const wrapCol = (c: number) => (c < 0 ? COLS - 1 : c >= COLS ? 0 : c);
const tileAt = (c: number, r: number) => (r < 0 || r >= ROWS ? "#" : MAZE[r][wrapCol(c)]);

/** Pac-Man may not enter the house or its door; ghosts may. */
function open(c: number, r: number, ghost: boolean): boolean {
  const t = tileAt(c, r);
  if (t === "#" || t === " ") return false;
  if ((t === "-" || t === "G") && !ghost) return false;
  return true;
}

const idx = (c: number, r: number) => r * COLS + c;

/** Where the pieces start, read out of the maze rather than hardcoded. */
const LAYOUT = (() => {
  let pac = { c: 9, r: 15 };
  let door = { c: 9, r: 8 };
  const house: { c: number; r: number }[] = [];
  const pellets: number[] = [];
  const power = new Set<number>();
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const t = MAZE[r][c];
      if (t === "P") pac = { c, r };
      if (t === "-") door = { c, r };
      if (t === "G") house.push({ c, r });
      if (t === "." || t === "o") pellets.push(idx(c, r));
      if (t === "o") power.add(idx(c, r));
    }
  }
  return { pac, door, house, pellets, power };
})();

/** Blinky waits above the door, as in the arcade; the rest start inside. */
const BLINKY_START = { c: LAYOUT.door.c, r: LAYOUT.door.r - 1 };

type GhostName = "blinky" | "pinky" | "inky" | "clyde";

/** Ghost colours are the content, so these four are literals. */
const GHOST_COLOUR: Record<GhostName, string> = {
  blinky: "#ff2f2f",
  pinky: "#ff9ed2",
  inky: "#39d7ec",
  clyde: "#ffab3d",
};

/** Scatter corners, one per ghost, just outside the maze. */
const CORNER: Record<GhostName, { c: number; r: number }> = {
  blinky: { c: COLS - 2, r: -1 },
  pinky: { c: 1, r: -1 },
  inky: { c: COLS - 1, r: ROWS },
  clyde: { c: 0, r: ROWS },
};

type GhostMode = "scatter" | "chase" | "frightened" | "eaten" | "housed";

interface Mover {
  c: number;
  r: number;
  /** Progress toward the next cell in `dir`, 0 to 1. */
  p: number;
  dir: Dir;
  /** Buffered turn, applied at the next cell if legal. */
  want: Dir | null;
}

interface Ghost extends Mover {
  name: GhostName;
  mode: GhostMode;
  /** Milliseconds left in the house before this ghost leaves. */
  waitMs: number;
}

/** Speeds in cells per second. Ghosts are a touch slower than Pac-Man. */
const PAC_SPEED = 7.2;
const GHOST_SPEED = 6.6;
const FRIGHT_SPEED = 4.2;
const EATEN_SPEED = 14;
const SPEED_PER_LEVEL = 0.45;

const FRIGHT_MS = 7000;
/** Scatter, chase, scatter, chase, then chase for good, as in the arcade. */
const MODE_PLAN = [7000, 20000, 7000, 20000, 5000, Infinity];

const DIFFICULTIES = ["easy", "normal", "hard"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];
const isDifficulty = (v: string): v is Difficulty => (DIFFICULTIES as readonly string[]).includes(v);
const DIFFICULTY_SPEED: Record<Difficulty, number> = { easy: -0.9, normal: 0, hard: 1.1 };

const newMover = (at: { c: number; r: number }, dir: Dir): Mover => ({ ...at, p: 0, dir, want: null });

function newGhosts(): Ghost[] {
  const [a, b, cc] = LAYOUT.house;
  return [
    { ...newMover(BLINKY_START, "left"), name: "blinky", mode: "scatter", waitMs: 0 },
    { ...newMover(a ?? BLINKY_START, "up"), name: "pinky", mode: "housed", waitMs: 1200 },
    { ...newMover(b ?? BLINKY_START, "up"), name: "inky", mode: "housed", waitMs: 4200 },
    { ...newMover(cc ?? BLINKY_START, "up"), name: "clyde", mode: "housed", waitMs: 8200 },
  ];
}

/** Live state the frame loop owns. React never re-renders for these. */
interface Live {
  pac: Mover;
  ghosts: Ghost[];
  /** Remaining pellets, by cell index. */
  pellets: Set<number>;
  modeStep: number;
  modeMs: number;
  frightMs: number;
  chain: number;
  dyingMs: number;
  readyMs: number;
}

function newLive(): Live {
  return {
    pac: newMover(LAYOUT.pac, "left"),
    ghosts: newGhosts(),
    pellets: new Set(LAYOUT.pellets),
    modeStep: 0,
    modeMs: 0,
    frightMs: 0,
    chain: 0,
    dyingMs: 0,
    readyMs: 900,
  };
}

/**
 * Advance a mover by `dist` cells, one cell boundary at a time.
 *
 * Stepping rather than sliding is what keeps this honest: a long frame cannot
 * skip a wall or a pellet, because every cell entered is visited.
 *
 * The invariant is that `p` only ever grows toward a cell already known to be
 * open. Two callbacks keep that true. `onEnter` runs once per cell actually
 * entered and carries the side effects; `chooseDir` picks the heading and may
 * be asked more than once, including while standing still, so a mover pinned
 * against a wall can still turn.
 *
 * That last part was a real bug: with a single callback, a blocked mover
 * returned with its heading into the wall and `p` at zero, and the next frame
 * took the "less than a cell to go" branch and incremented `p` with no check.
 * Eight frames later it stepped inside the wall.
 */
function advance(
  m: Mover,
  dist: number,
  ghost: boolean,
  onEnter: (m: Mover) => void,
  chooseDir: (m: Mover) => Dir,
): void {
  const blocked = (dir: Dir) => !open(m.c + DELTA[dir].dc, m.r + DELTA[dir].dr, ghost);

  // Standing on a centre facing a wall: re-ask, then stay put if still walled.
  if (m.p === 0 && blocked(m.dir)) {
    m.dir = chooseDir(m);
    if (blocked(m.dir)) return;
  }

  let remaining = dist;
  let guard = 0;
  while (remaining > 1e-9 && guard++ < 16) {
    const room = 1 - m.p;
    if (remaining < room) {
      m.p += remaining;
      return;
    }
    // Land exactly on the next cell, which the checks above proved is open.
    remaining -= room;
    const d = DELTA[m.dir];
    m.c = wrapCol(m.c + d.dc);
    m.r = m.r + d.dr;
    m.p = 0;

    onEnter(m);
    m.dir = chooseDir(m);
    if (blocked(m.dir)) return;
  }
}

/**
 * Turn a mover around mid-cell.
 *
 * The cell reference has to move with it. A mover 0.6 of the way from A to B
 * is, after reversing, 0.4 of the way from B back to A, so `c` and `r` become
 * B and `p` becomes 1 - p. Flipping only `dir` leaves the mover claiming to
 * stand on A while heading at a cell nobody checked, which is exactly how a
 * frightened ghost ended up inside a wall.
 *
 * At a cell centre there is nothing to rebase, and the direction may well face
 * a wall; `advance` re-asks in that case rather than creeping into it.
 */
function reverse(m: Mover): void {
  if (m.p > 0) {
    const d = DELTA[m.dir];
    m.c = wrapCol(m.c + d.dc);
    m.r = m.r + d.dr;
    m.p = 1 - m.p;
  }
  m.dir = OPPOSITE[m.dir];
}

/** Legal exits from a cell, never straight back the way we came. */
function exits(m: Mover, ghost: boolean, allowReverse = false): Dir[] {
  const back = OPPOSITE[m.dir];
  return DIRS.filter(
    (d) => (allowReverse || d !== back) && open(m.c + DELTA[d].dc, m.r + DELTA[d].dr, ghost),
  );
}

const dist2 = (ac: number, ar: number, bc: number, br: number) =>
  (ac - bc) * (ac - bc) + (ar - br) * (ar - br);

/** Each ghost's target tile. This is the whole personality of the game. */
function targetFor(g: Ghost, pac: Mover, blinky: Ghost): { c: number; r: number } {
  if (g.mode === "eaten") return LAYOUT.door;
  if (g.mode === "scatter") return CORNER[g.name];

  const pd = DELTA[pac.dir];
  switch (g.name) {
    case "blinky":
      return { c: pac.c, r: pac.r };
    case "pinky":
      // Four ahead, so he arrives where Pac-Man is going rather than where he is.
      return { c: pac.c + pd.dc * 4, r: pac.r + pd.dr * 4 };
    case "inky": {
      // Two ahead of Pac-Man, then that vector from Blinky doubled.
      const ac = pac.c + pd.dc * 2;
      const ar = pac.r + pd.dr * 2;
      return { c: ac + (ac - blinky.c), r: ar + (ar - blinky.r) };
    }
    case "clyde":
      // Bold until he gets close, then he loses his nerve.
      return dist2(g.c, g.r, pac.c, pac.r) > 64 ? { c: pac.c, r: pac.r } : CORNER.clyde;
  }
}

/** Continuous position for rendering, in cell units. */
const posOf = (m: Mover) => {
  const d = DELTA[m.dir];
  return { x: m.c + d.dc * m.p, y: m.r + d.dr * m.p };
};

const ROT: Record<Dir, number> = { right: 0, down: 90, left: 180, up: 270 };

export default function Pacman({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [status, setStatus] = useState<GameStatus>("ready");
  const [score, setScore] = useState(0);
  const [lives, setLives] = useState(3);
  const [level, setLevel] = useState(1);
  const [left, setLeft] = useState(LAYOUT.pellets.length);
  const [frightened, setFrightened] = useState(false);
  const [flash, setFlash] = useState("");

  const live = useRef<Live>(newLive());
  const pacEl = useRef<HTMLDivElement>(null);
  const ghostEls = useRef<(HTMLDivElement | null)[]>([]);

  const best = useBest(score);

  useEffect(() => {
    const d = seedString(seed, "difficulty");
    if (d && isDifficulty(d)) setDifficulty(d);
  }, [seed]);

  const speedBonus = (level - 1) * SPEED_PER_LEVEL + DIFFICULTY_SPEED[difficulty];

  /** Write the five movers straight to the DOM. No React work per frame. */
  const paint = useCallback(() => {
    const g = live.current;
    const put = (el: HTMLDivElement | null, m: Mover, extra = "") => {
      if (!el) return;
      const { x, y } = posOf(m);
      el.style.transform = `translate(${x * 100}%, ${y * 100}%) ${extra}`;
    };
    put(pacEl.current, g.pac, `rotate(${ROT[g.pac.dir]}deg)`);
    g.ghosts.forEach((gh, i) => put(ghostEls.current[i], gh));
  }, []);

  useEffect(() => {
    paint();
  }, [paint, status]);

  const reset = useCallback((keepScore = false, nextLevel = 1) => {
    live.current = newLive();
    setLeft(LAYOUT.pellets.length);
    setFrightened(false);
    setLevel(nextLevel);
    if (!keepScore) {
      setScore(0);
      setLives(3);
    }
    setStatus("ready");
    paint();
  }, [paint]);

  /** Put everyone back after a death, keeping the pellets already eaten. */
  const respawn = useCallback(() => {
    const g = live.current;
    g.pac = newMover(LAYOUT.pac, "left");
    g.ghosts = newGhosts();
    g.frightMs = 0;
    g.chain = 0;
    g.modeStep = 0;
    g.modeMs = 0;
    g.dyingMs = 0;
    g.readyMs = 900;
    setFrightened(false);
    paint();
  }, [paint]);

  const running = status === "playing";

  useFrameLoop(running, (dtMs) => {
    const g = live.current;
    const dt = dtMs / 1000;

    // A short beat before each life so the player can see the board.
    if (g.readyMs > 0) {
      g.readyMs -= dtMs;
      return;
    }

    // Death pause, then either respawn or end the game.
    if (g.dyingMs > 0) {
      g.dyingMs -= dtMs;
      if (g.dyingMs <= 0) {
        setLives((n) => {
          const remaining = n - 1;
          if (remaining <= 0) setStatus("over");
          else respawn();
          return remaining;
        });
      }
      return;
    }

    // Mode timer. Frightened overrides the scatter and chase plan.
    if (g.frightMs > 0) {
      g.frightMs -= dtMs;
      if (g.frightMs <= 0) {
        g.chain = 0;
        setFrightened(false);
        for (const gh of g.ghosts) if (gh.mode === "frightened") gh.mode = "chase";
      }
    } else {
      g.modeMs += dtMs;
      const planned = MODE_PLAN[Math.min(g.modeStep, MODE_PLAN.length - 1)];
      if (g.modeMs >= planned) {
        g.modeMs = 0;
        g.modeStep++;
        const scatter = g.modeStep % 2 === 0;
        for (const gh of g.ghosts) {
          if (gh.mode === "scatter" || gh.mode === "chase") gh.mode = scatter ? "scatter" : "chase";
        }
      }
    }

    // ---- Pac-Man ----
    advance(
      g.pac,
      (PAC_SPEED + speedBonus) * dt,
      false,
      (m) => {
        const cell = idx(m.c, m.r);
        if (!g.pellets.has(cell)) return;
        g.pellets.delete(cell);
        const isPower = LAYOUT.power.has(cell);
        setScore((n) => n + (isPower ? 50 : 10));
        setLeft(g.pellets.size);
        if (isPower) {
          g.frightMs = FRIGHT_MS;
          g.chain = 0;
          setFrightened(true);
          for (const gh of g.ghosts) {
            if (gh.mode === "scatter" || gh.mode === "chase") {
              gh.mode = "frightened";
              // Frightened ghosts turn around, which is the player's opening.
              reverse(gh);
            }
          }
        }
        if (g.pellets.size === 0) setStatus("won");
      },
      (m) => {
        // Take the buffered turn if it is legal here, else carry on.
        if (m.want && open(m.c + DELTA[m.want].dc, m.r + DELTA[m.want].dr, false)) {
          const d = m.want;
          m.want = null;
          return d;
        }
        return m.dir;
      },
    );

    // ---- Ghosts ----
    const blinky = g.ghosts[0];
    for (const gh of g.ghosts) {
      if (gh.mode === "housed") {
        gh.waitMs -= dtMs;
        if (gh.waitMs <= 0) {
          gh.mode = g.frightMs > 0 ? "frightened" : "chase";
          // Leave through the door rather than walking into a wall.
          gh.c = LAYOUT.door.c;
          gh.r = LAYOUT.door.r;
          gh.p = 0;
          gh.dir = "up";
        }
        continue;
      }

      const speed =
        gh.mode === "eaten"
          ? EATEN_SPEED
          : gh.mode === "frightened"
            ? FRIGHT_SPEED
            : GHOST_SPEED + speedBonus;

      advance(
        gh,
        speed * dt,
        true,
        (m) => {
          const self = m as Ghost;
          // Home at last: sit in the house for a moment, then rejoin.
          if (self.mode === "eaten" && self.c === LAYOUT.door.c && self.r === LAYOUT.door.r) {
            self.mode = "housed";
            self.waitMs = 1400;
          }
        },
        (m) => {
          const self = m as Ghost;
          if (self.mode === "housed") return "down";
          const options = exits(self, true);
          // A dead end is the one place reversing is allowed.
          const choices = options.length ? options : exits(self, true, true);
          if (choices.length === 0) return OPPOSITE[self.dir];
          if (choices.length === 1) return choices[0];

          if (self.mode === "frightened") return choices[randInt(0, choices.length - 1)];

          const t = targetFor(self, g.pac, blinky);
          let bestDir = choices[0];
          let bestScore = Infinity;
          for (const d of choices) {
            const nc = wrapCol(self.c + DELTA[d].dc);
            const nr = self.r + DELTA[d].dr;
            const score = dist2(nc, nr, t.c, t.r);
            if (score < bestScore) {
              bestScore = score;
              bestDir = d;
            }
          }
          return bestDir;
        },
      );
    }

    // ---- Contact ----
    const pp = posOf(g.pac);
    for (const gh of g.ghosts) {
      if (gh.mode === "housed" || gh.mode === "eaten") continue;
      const gp = posOf(gh);
      if (dist2(pp.x, pp.y, gp.x, gp.y) > 0.36) continue; // within 0.6 of a cell
      if (gh.mode === "frightened") {
        g.chain = Math.min(g.chain + 1, 4);
        const points = 200 * 2 ** (g.chain - 1);
        setScore((n) => n + points);
        setFlash(`${points}`);
        window.setTimeout(() => setFlash(""), 800);
        gh.mode = "eaten";
      } else {
        g.dyingMs = 1100;
        return;
      }
    }

    paint();
  });

  // ---- Input ----
  const steer = useCallback((dir: Direction) => {
    const g = live.current;
    if (status === "ready") {
      setStatus("playing");
    }
    g.pac.want = dir;
    // A reversal needs no junction, so it applies at once.
    if (dir === OPPOSITE[g.pac.dir]) {
      reverse(g.pac);
      g.pac.want = null;
    }
  }, [status]);

  useDirectionKeys(steer, undefined, !isTerminal(status));
  useKeys({ enter: () => status === "ready" && setStatus("playing") });
  const swipe = useSwipe(steer);

  const nextLevel = useCallback(() => {
    live.current = newLive();
    setLeft(LAYOUT.pellets.length);
    setFrightened(false);
    setLevel((n) => n + 1);
    setStatus("playing");
    paint();
  }, [paint]);

  useGameOverReport(runtime, isTerminal(status), () =>
    status === "won"
      ? `Pac-Man level ${level} cleared with ${score} points, ${lives} lives left.`
      : `Pac-Man over on level ${level}: ${score} points, ${left} pellets left.`,
  );

  const tell = useCallback(() => {
    void share(`I scored ${score} at Pac-Man on level ${level}.`, `Pac-Man: ${left} pellets left.`);
  }, [share, score, level, left]);

  // The walls never change, so they are built once.
  const walls = useMemo(
    () =>
      MAZE.flatMap((row, r) =>
        Array.from(row).map((t, c) =>
          t === "#" ? (
            <div key={`w${r}-${c}`} className={s.wall} style={sv({ "--c": c, "--r": r })} />
          ) : null,
        ),
      ).filter(Boolean),
    [],
  );

  // Pellets re-render only when one is eaten, not every frame.
  const pellets = useMemo(
    () =>
      LAYOUT.pellets
        .filter((cell) => live.current.pellets.has(cell))
        .map((cell) => {
          const c = cell % COLS;
          const r = Math.floor(cell / COLS);
          return (
            <div
              key={cell}
              className={LAYOUT.power.has(cell) ? s.power : s.pellet}
              style={sv({ "--c": c, "--r": r })}
            />
          );
        }),
    [left],
  );

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Pac-Man"
        stats={[
          { label: "Score", value: score },
          { label: "Lives", value: lives },
          { label: "Level", value: level },
          { label: "Best", value: best },
        ]}
        hint={status === "ready" ? "Arrows, swipe or the pad to start" : undefined}
      />

      <div className={s.boardWrap} style={sv({ "--cols": COLS, "--rows": ROWS })}>
        <div
          className={`${s.board} ${frightened ? s.fright : ""}`}
          role="img"
          aria-label={`Pac-Man maze, ${left} pellets left, ${lives} lives`}
          {...swipe}
        >
          {walls}
          {pellets}

          {live.current.ghosts.map((gh, i) => (
            <div
              key={gh.name}
              ref={(el) => {
                ghostEls.current[i] = el;
              }}
              className={s.ghost}
              style={sv({ "--tint": GHOST_COLOUR[gh.name] })}
              data-mode={gh.mode}
            >
              <GhostSprite />
            </div>
          ))}

          <div ref={pacEl} className={`${s.pac} ${live.current.dyingMs > 0 ? s.dying : ""}`}>
            <span className={s.pacBody} />
          </div>

          {flash && <span className={s.points}>{flash}</span>}

          <Overlay
            status={status}
            title={status === "won" ? `Level ${level} cleared` : status === "over" ? "Game over" : "Pac-Man"}
            detail={
              status === "won"
                ? `${score} points, ${lives} lives left.`
                : status === "over"
                  ? `${score} points on level ${level}.`
                  : "Eat every pellet. A power pellet makes the ghosts edible."
            }
            action={status === "won" ? "Next level" : status === "over" ? "Play again" : "Play"}
            onAction={
              status === "won" ? nextLevel : status === "over" ? () => reset(false, 1) : () => setStatus("playing")
            }
          />
        </div>
      </div>

      <DPad onDirection={steer} />

      <ControlBar>
        <button className={ui.btn} onClick={() => reset(false, 1)}>
          Restart
        </button>
        <button className={ui.btn} onClick={tell} disabled={!isTerminal(status)}>
          Tell the model
        </button>
      </ControlBar>

      {frightened && <Notice>Ghosts are edible. Each one in a row is worth double.</Notice>}

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}

/** The classic dome with a scalloped hem, plus eyes that follow the tint. */
function GhostSprite() {
  return (
    <svg viewBox="0 0 20 20" className={s.ghostSvg} aria-hidden="true">
      <path
        className={s.ghostBody}
        d="M2 11a8 8 0 0 1 16 0v7l-2.7-1.8L12.6 18l-2.6-1.8L7.4 18l-2.7-1.8L2 18z"
      />
      <circle className={s.eyeWhite} cx="7.2" cy="9.4" r="2.5" />
      <circle className={s.eyeWhite} cx="12.8" cy="9.4" r="2.5" />
      <circle className={s.pupil} cx="7.2" cy="9.8" r="1.2" />
      <circle className={s.pupil} cx="12.8" cy="9.8" r="1.2" />
    </svg>
  );
}
