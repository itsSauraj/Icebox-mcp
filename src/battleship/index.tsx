/**
 * @file Battleship: place a fleet, then trade salvos with a hunting AI.
 *
 * The opponent is the whole game, so it gets three real strategies rather than
 * one with a difficulty multiplier:
 *
 *  - **easy** fires at random untried cells, with a single follow-up probe
 *    after a hit. Beatable by anyone.
 *  - **normal** is hunt-and-target with parity. In hunt mode it only considers
 *    cells on a checkerboard whose spacing matches the smallest ship still
 *    afloat, which halves the search space for no loss, because a ship of
 *    length n must cover at least one cell of an n-spaced lattice. On a hit it
 *    switches to target mode, probes neighbours, and once two hits line up it
 *    extends along that axis until the ship sinks.
 *  - **hard** adds probability density: for every remaining ship, count how
 *    many legal placements would cover each cell, and fire at the highest
 *    count. That is how a strong human plays, and it is genuinely hard.
 *
 * The AI fleet is not placed in a state initialiser. StrictMode double-invokes
 * initialisers and would produce two different fleets.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randInt, shuffle } from "../lib/rng";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  Segmented,
  StatusLine,
  clamp,
  isTerminal,
  seedString,
  sv,
  useDirectionKeys,
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
import s from "./battleship.module.css";

const SIZE = 10;
const CELLS = SIZE * SIZE;

interface ShipDef {
  name: string;
  length: number;
}

const FLEET: ShipDef[] = [
  { name: "Carrier", length: 5 },
  { name: "Battleship", length: 4 },
  { name: "Cruiser", length: 3 },
  { name: "Submarine", length: 3 },
  { name: "Destroyer", length: 2 },
];

const DIFFICULTIES = ["easy", "normal", "hard"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];
const isDifficulty = (v: string): v is Difficulty => (DIFFICULTIES as readonly string[]).includes(v);

interface Ship {
  def: ShipDef;
  cells: number[];
  hits: number;
}

const rc = (i: number) => ({ r: Math.floor(i / SIZE), c: i % SIZE });
const idx = (r: number, c: number) => r * SIZE + c;
const inBoard = (r: number, c: number) => r >= 0 && r < SIZE && c >= 0 && c < SIZE;
const coordLabel = (i: number) => `${String.fromCharCode(65 + rc(i).c)}${rc(i).r + 1}`;

/** Cells a ship would occupy, or null if it does not fit or overlaps. */
function placement(start: number, length: number, horizontal: boolean, taken: Set<number>): number[] | null {
  const { r, c } = rc(start);
  const cells: number[] = [];
  for (let k = 0; k < length; k++) {
    const rr = horizontal ? r : r + k;
    const cc = horizontal ? c + k : c;
    if (!inBoard(rr, cc)) return null;
    const i = idx(rr, cc);
    if (taken.has(i)) return null;
    cells.push(i);
  }
  return cells;
}

/** A random legal fleet. Never called from a state initialiser. */
function randomFleet(): Ship[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const taken = new Set<number>();
    const ships: Ship[] = [];
    let ok = true;
    for (const def of FLEET) {
      let placed = false;
      for (let tries = 0; tries < 300 && !placed; tries++) {
        const horizontal = Math.random() < 0.5;
        const cells = placement(randInt(0, CELLS - 1), def.length, horizontal, taken);
        if (!cells) continue;
        cells.forEach((i) => taken.add(i));
        ships.push({ def, cells, hits: 0 });
        placed = true;
      }
      if (!placed) {
        ok = false;
        break;
      }
    }
    if (ok) return ships;
  }
  // Fallback that always fits: one ship per row.
  return FLEET.map((def, r) => ({
    def,
    cells: Array.from({ length: def.length }, (_, k) => idx(r * 2, k)),
    hits: 0,
  }));
}

type Shot = "miss" | "hit";

interface Side {
  ships: Ship[];
  shots: Map<number, Shot>;
}

const sunkShips = (side: Side) => side.ships.filter((sh) => sh.hits >= sh.def.length);
const allSunk = (side: Side) => side.ships.every((sh) => sh.hits >= sh.def.length);

/** Apply a shot to a side, returning the result and any ship sunk. */
function fireAt(side: Side, cell: number): { shot: Shot; sunk: Ship | null } {
  const ship = side.ships.find((sh) => sh.cells.includes(cell));
  if (!ship) {
    side.shots.set(cell, "miss");
    return { shot: "miss", sunk: null };
  }
  side.shots.set(cell, "hit");
  ship.hits += 1;
  return { shot: "hit", sunk: ship.hits >= ship.def.length ? ship : null };
}

/* ------------------------------------------------------------------ */
/* Opponent                                                            */
/* ------------------------------------------------------------------ */

interface AiState {
  /** Unresolved hits that belong to a ship still afloat. */
  live: number[];
}

const smallestAfloat = (side: Side) => {
  const lengths = side.ships.filter((sh) => sh.hits < sh.def.length).map((sh) => sh.def.length);
  return lengths.length ? Math.min(...lengths) : 2;
};

/** Untried cells whose parity matches the smallest ship still afloat. */
function parityCells(side: Side, span: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (side.shots.has(i)) continue;
    const { r, c } = rc(i);
    if ((r + c) % span === 0) out.push(i);
  }
  return out.length ? out : Array.from({ length: CELLS }, (_, i) => i).filter((i) => !side.shots.has(i));
}

/**
 * Probability density: for every ship still afloat, count how many legal
 * placements cover each untried cell. Placements may not cross a known miss or
 * a sunk ship's cells, and a placement covering a live hit is weighted up,
 * because a ship is demonstrably there.
 */
function densityTarget(side: Side, ai: AiState): number {
  const blocked = new Set<number>();
  for (const [cell, shot] of side.shots) {
    if (shot === "miss") blocked.add(cell);
  }
  for (const sh of sunkShips(side)) sh.cells.forEach((i) => blocked.add(i));

  const liveSet = new Set(ai.live);
  const score = new Array(CELLS).fill(0);

  for (const sh of side.ships) {
    if (sh.hits >= sh.def.length) continue;
    const len = sh.def.length;
    for (let r = 0; r < SIZE; r++) {
      for (let c = 0; c < SIZE; c++) {
        for (const horizontal of [true, false]) {
          const cells = placement(idx(r, c), len, horizontal, blocked);
          if (!cells) continue;
          const covers = cells.filter((i) => liveSet.has(i)).length;
          const weight = covers > 0 ? 40 * covers : 1;
          for (const i of cells) if (!side.shots.has(i)) score[i] += weight;
        }
      }
    }
  }

  let best = -1;
  let bestCells: number[] = [];
  for (let i = 0; i < CELLS; i++) {
    if (side.shots.has(i)) continue;
    if (score[i] > best) {
      best = score[i];
      bestCells = [i];
    } else if (score[i] === best) {
      bestCells.push(i);
    }
  }
  return bestCells.length ? bestCells[randInt(0, bestCells.length - 1)] : firstUntried(side);
}

const firstUntried = (side: Side) => {
  for (let i = 0; i < CELLS; i++) if (!side.shots.has(i)) return i;
  return 0;
};

/** Neighbours of a live hit, or an extension along a confirmed axis. */
function targetFromHits(side: Side, ai: AiState): number | null {
  if (ai.live.length === 0) return null;

  // Two or more live hits in a line: extend that line at either end.
  if (ai.live.length >= 2) {
    const sorted = ai.live.slice().sort((a, b) => a - b);
    const first = rc(sorted[0]);
    const last = rc(sorted[sorted.length - 1]);
    const horizontal = first.r === last.r;
    const candidates: number[] = [];
    if (horizontal) {
      if (inBoard(first.r, first.c - 1)) candidates.push(idx(first.r, first.c - 1));
      if (inBoard(last.r, last.c + 1)) candidates.push(idx(last.r, last.c + 1));
    } else {
      if (inBoard(first.r - 1, first.c)) candidates.push(idx(first.r - 1, first.c));
      if (inBoard(last.r + 1, last.c)) candidates.push(idx(last.r + 1, last.c));
    }
    const open = candidates.filter((i) => !side.shots.has(i));
    if (open.length) return open[randInt(0, open.length - 1)];
  }

  // A single live hit: probe its four neighbours.
  for (const hit of shuffle(ai.live)) {
    const { r, c } = rc(hit);
    const neighbours = [idx(r - 1, c), idx(r + 1, c), idx(r, c - 1), idx(r, c + 1)].filter((i) => {
      const p = rc(i);
      return inBoard(p.r, p.c) && Math.abs(p.r - r) + Math.abs(p.c - c) === 1 && !side.shots.has(i);
    });
    if (neighbours.length) return neighbours[randInt(0, neighbours.length - 1)];
  }
  return null;
}

function chooseShot(side: Side, ai: AiState, difficulty: Difficulty): number {
  if (difficulty === "easy") {
    // One follow-up probe only, then straight back to random.
    if (ai.live.length === 1) {
      const t = targetFromHits(side, ai);
      if (t !== null) return t;
    }
    const open = Array.from({ length: CELLS }, (_, i) => i).filter((i) => !side.shots.has(i));
    return open.length ? open[randInt(0, open.length - 1)] : 0;
  }

  const targeted = targetFromHits(side, ai);
  if (targeted !== null) return targeted;

  if (difficulty === "hard") return densityTarget(side, ai);

  const pool = parityCells(side, smallestAfloat(side));
  return pool[randInt(0, pool.length - 1)];
}

/* ------------------------------------------------------------------ */

type Phase = "placing" | "battle" | "done";

export default function Battleship({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [phase, setPhase] = useState<Phase>("placing");
  const [horizontal, setHorizontal] = useState(true);
  const [placeIndex, setPlaceIndex] = useState(0);
  const [myShips, setMyShips] = useState<Ship[]>([]);
  const [cursor, setCursor] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  const [me, setMe] = useState<Side>({ ships: [], shots: new Map() });
  const [foe, setFoe] = useState<Side>({ ships: [], shots: new Map() });
  const [aiState, setAiState] = useState<AiState>({ live: [] });
  const [log, setLog] = useState<string[]>([]);
  const [myTurn, setMyTurn] = useState(true);
  const [shots, setShots] = useState(0);
  const [hits, setHits] = useState(0);
  const [status, setStatus] = useState<GameStatus>("ready");

  useEffect(() => {
    const d = seedString(seed, "difficulty");
    if (d && isDifficulty(d)) setDifficulty(d);
  }, [seed]);

  const taken = useMemo(() => new Set(myShips.flatMap((sh) => sh.cells)), [myShips]);
  const nextShip = FLEET[placeIndex];

  const preview = useMemo(() => {
    if (phase !== "placing" || !nextShip) return null;
    const at = hover ?? cursor;
    return placement(at, nextShip.length, horizontal, taken);
  }, [phase, nextShip, hover, cursor, horizontal, taken]);

  const placeAt = useCallback(
    (cell: number) => {
      if (phase !== "placing" || !nextShip) return;
      const cells = placement(cell, nextShip.length, horizontal, taken);
      if (!cells) return;
      setMyShips((prev) => [...prev, { def: nextShip, cells, hits: 0 }]);
      setPlaceIndex((i) => i + 1);
    },
    [phase, nextShip, horizontal, taken],
  );

  const randomiseFleet = useCallback(() => {
    setMyShips(randomFleet());
    setPlaceIndex(FLEET.length);
  }, []);

  const clearFleet = useCallback(() => {
    setMyShips([]);
    setPlaceIndex(0);
  }, []);

  const startBattle = useCallback(() => {
    if (myShips.length !== FLEET.length) return;
    // The AI fleet is generated here, never in an initialiser.
    setMe({ ships: myShips.map((sh) => ({ ...sh, hits: 0 })), shots: new Map() });
    setFoe({ ships: randomFleet(), shots: new Map() });
    setAiState({ live: [] });
    setLog([]);
    setMyTurn(true);
    setShots(0);
    setHits(0);
    setStatus("playing");
    setPhase("battle");
    setCursor(0);
  }, [myShips]);

  const reset = useCallback(() => {
    setPhase("placing");
    setMyShips([]);
    setPlaceIndex(0);
    setMe({ ships: [], shots: new Map() });
    setFoe({ ships: [], shots: new Map() });
    setAiState({ live: [] });
    setLog([]);
    setStatus("ready");
    setShots(0);
    setHits(0);
    setCursor(0);
  }, []);

  const fire = useCallback(
    (cell: number) => {
      if (phase !== "battle" || !myTurn || status !== "playing") return;
      if (foe.shots.has(cell)) return;

      const next: Side = { ships: foe.ships.map((sh) => ({ ...sh })), shots: new Map(foe.shots) };
      const { shot, sunk } = fireAt(next, cell);
      setFoe(next);
      setShots((n) => n + 1);
      if (shot === "hit") setHits((n) => n + 1);
      setLog((l) => [
        `You fired at ${coordLabel(cell)}: ${shot}${sunk ? `, sank their ${sunk.def.name}` : ""}.`,
        ...l,
      ].slice(0, 30));

      if (allSunk(next)) {
        setStatus("won");
        return;
      }
      setMyTurn(false);
    },
    [phase, myTurn, status, foe],
  );

  // The opponent replies after a short beat, so a salvo lands rather than
  // appearing the instant the player lifts a finger.
  useEffect(() => {
    if (phase !== "battle" || myTurn || status !== "playing") return;
    const id = window.setTimeout(() => {
      setMe((current) => {
        const next: Side = { ships: current.ships.map((sh) => ({ ...sh })), shots: new Map(current.shots) };
        const cell = chooseShot(next, aiState, difficulty);
        const { shot, sunk } = fireAt(next, cell);

        setAiState((st) => {
          if (shot === "miss") return st;
          const live = [...st.live, cell];
          // A sunk ship's hits are resolved, so drop them from the live list.
          return sunk ? { live: live.filter((i) => !sunk.cells.includes(i)) } : { live };
        });

        setLog((l) => [
          `They fired at ${coordLabel(cell)}: ${shot}${sunk ? `, sank your ${sunk.def.name}` : ""}.`,
          ...l,
        ].slice(0, 30));

        if (allSunk(next)) setStatus("over");
        else setMyTurn(true);
        return next;
      });
    }, 520);
    return () => window.clearTimeout(id);
  }, [phase, myTurn, status, aiState, difficulty]);

  const onDirection = useCallback(
    (dir: Direction) => {
      const { r, c } = rc(cursor);
      const dr = dir === "up" ? -1 : dir === "down" ? 1 : 0;
      const dc = dir === "left" ? -1 : dir === "right" ? 1 : 0;
      setCursor(idx(clamp(r + dr, 0, SIZE - 1), clamp(c + dc, 0, SIZE - 1)));
    },
    [cursor],
  );

  useDirectionKeys(onDirection, undefined, status !== "over" && status !== "won");
  useKeys({
    r: () => setHorizontal((h) => !h),
    enter: () => (phase === "placing" ? placeAt(cursor) : fire(cursor)),
  });

  useGameOverReport(runtime, isTerminal(status), () => {
    const acc = shots > 0 ? Math.round((hits / shots) * 100) : 0;
    return status === "won"
      ? `Won Battleship on ${difficulty}: sank the fleet in ${shots} shots, ${acc}% accuracy.`
      : `Lost Battleship on ${difficulty} after ${shots} shots, ${acc}% accuracy.`;
  });

  const tell = useCallback(() => {
    const acc = shots > 0 ? Math.round((hits / shots) * 100) : 0;
    void share(
      `I ${status === "won" ? "sank" : "lost to"} the Battleship fleet on ${difficulty} with ${acc}% accuracy.`,
      `Battleship: ${shots} shots, ${hits} hits.`,
    );
  }, [share, status, difficulty, shots, hits]);

  const myAfloat = FLEET.length - sunkShips(me).length;
  const foeAfloat = FLEET.length - sunkShips(foe).length;
  const accuracy = shots > 0 ? Math.round((hits / shots) * 100) : 0;

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Battleship"
        stats={
          phase === "placing"
            ? [{ label: "To place", value: FLEET.length - placeIndex }]
            : [
                { label: "Yours", value: myAfloat },
                { label: "Theirs", value: foeAfloat },
                { label: "Shots", value: shots },
                { label: "Accuracy", value: `${accuracy}%` },
              ]
        }
        hint={
          phase === "placing"
            ? nextShip
              ? `Place your ${nextShip.name} (${nextShip.length})`
              : "Fleet ready"
            : status === "playing"
              ? myTurn
                ? "Your shot"
                : "They are firing"
              : undefined
        }
      />

      {phase === "placing" ? (
        <>
          <Grid
            label="Your waters"
            cursor={cursor}
            onCursor={setCursor}
            onHover={setHover}
            onPick={placeAt}
            cellClass={(i) => {
              const mine = taken.has(i);
              const inPreview = preview?.includes(i) ?? false;
              const bad = preview === null && (hover ?? cursor) === i;
              return `${mine ? s.ship : ""} ${inPreview ? s.previewOk : ""} ${bad ? s.previewBad : ""}`;
            }}
            cellLabel={(i) => `${coordLabel(i)}${taken.has(i) ? ", your ship" : ""}`}
          />

          <ControlBar>
            <button className={ui.btn} onClick={() => setHorizontal((h) => !h)}>
              {horizontal ? "Horizontal" : "Vertical"}
            </button>
            <button className={ui.btn} onClick={randomiseFleet}>
              Random fleet
            </button>
            <button className={ui.btn} onClick={clearFleet} disabled={myShips.length === 0}>
              Clear
            </button>
            <button
              className={`${ui.btn} ${ui.primary}`}
              onClick={startBattle}
              disabled={myShips.length !== FLEET.length}
            >
              Start
            </button>
          </ControlBar>

          <Notice>Tap to place, R rotates. Ships may touch but not overlap.</Notice>
        </>
      ) : (
        <>
          <div className={s.boards}>
            <div className={s.boardCol}>
              <Grid
                label="Enemy waters"
                cursor={cursor}
                onCursor={setCursor}
                onPick={fire}
                disabled={!myTurn || status !== "playing"}
                cellClass={(i) => {
                  const shot = foe.shots.get(i);
                  const sunkHere = sunkShips(foe).some((sh) => sh.cells.includes(i));
                  return `${shot === "hit" ? s.hit : ""} ${shot === "miss" ? s.miss : ""} ${sunkHere ? s.sunk : ""}`;
                }}
                // Never reveals whether a ship is there before it is fired on.
                cellLabel={(i) => {
                  const shot = foe.shots.get(i);
                  return `${coordLabel(i)}${shot ? `, ${shot}` : ", not fired on"}`;
                }}
              />
            </div>

            <div className={s.boardCol}>
              <Grid
                label="Your waters"
                small
                cellClass={(i) => {
                  const shot = me.shots.get(i);
                  const mine = me.ships.some((sh) => sh.cells.includes(i));
                  const sunkHere = sunkShips(me).some((sh) => sh.cells.includes(i));
                  return `${mine ? s.ship : ""} ${shot === "hit" ? s.hit : ""} ${shot === "miss" ? s.miss : ""} ${sunkHere ? s.sunk : ""}`;
                }}
                cellLabel={(i) => {
                  const shot = me.shots.get(i);
                  const mine = me.ships.some((sh) => sh.cells.includes(i));
                  return `${coordLabel(i)}${mine ? ", your ship" : ""}${shot ? `, ${shot}` : ""}`;
                }}
              />
            </div>
          </div>

          <ul className={s.log} aria-label="Shot log">
            {log.slice(0, 6).map((entry, i) => (
              <li key={`${entry}-${i}`} className={s.logLine}>
                {entry}
              </li>
            ))}
          </ul>

          <ControlBar>
            <button className={ui.btn} onClick={reset}>
              New game
            </button>
            <button className={ui.btn} onClick={toggleFull}>
              {isFull ? "Exit fullscreen" : "Fullscreen"}
            </button>
            <button className={ui.btn} onClick={tell} disabled={!isTerminal(status)}>
              Tell the model
            </button>
          </ControlBar>
        </>
      )}

      <ControlBar>
        <Segmented
          label="Difficulty"
          options={DIFFICULTIES}
          value={difficulty}
          onChange={(d) => {
            setDifficulty(d);
            reset();
          }}
        />
      </ControlBar>

      {isTerminal(status) && (
        <div className={s.result}>
          <Overlay
            status={status}
            title={status === "won" ? "Fleet sunk" : "You were sunk"}
            detail={`${shots} shots at ${accuracy}% accuracy.`}
            action="New game"
            onAction={reset}
          />
        </div>
      )}

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}

/** One 10x10 grid with A-J / 1-10 headers and a roving tabindex. */
function Grid({
  label,
  small,
  cursor,
  onCursor,
  onHover,
  onPick,
  disabled,
  cellClass,
  cellLabel,
}: {
  label: string;
  small?: boolean;
  cursor?: number;
  onCursor?: (i: number) => void;
  onHover?: (i: number | null) => void;
  onPick?: (i: number) => void;
  disabled?: boolean;
  cellClass: (i: number) => string;
  cellLabel: (i: number) => string;
}) {
  const interactive = Boolean(onPick);
  return (
    <div className={`${s.gridWrap} ${small ? s.small : ""}`}>
      <p className={s.gridLabel}>{label}</p>
      <div
        className={s.grid}
        style={sv({ "--n": SIZE })}
        role="grid"
        aria-label={label}
        onPointerLeave={() => onHover?.(null)}
      >
        {Array.from({ length: CELLS }, (_, i) => (
          <button
            key={i}
            type="button"
            className={`${s.cell} ${cellClass(i)} ${cursor === i && interactive ? s.cursor : ""}`}
            role="gridcell"
            tabIndex={interactive && cursor === i ? 0 : -1}
            disabled={!interactive || disabled}
            onFocus={() => onCursor?.(i)}
            onPointerEnter={() => onHover?.(i)}
            onClick={() => onPick?.(i)}
            aria-label={cellLabel(i)}
          />
        ))}
      </div>
    </div>
  );
}
