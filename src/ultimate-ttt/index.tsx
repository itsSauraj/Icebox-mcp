/**
 * @file Ultimate Tic-Tac-Toe: nine boards, and your move picks the next one.
 *
 * State is two flat arrays: 81 cells and 9 board verdicts. Flat indexing keeps
 * every rule a bit of arithmetic (`board = floor(i / 9)`, `cell = i % 9`)
 * rather than nested loops.
 *
 * Three rules decide whether an implementation is correct, and all three are
 * easy to miss:
 *  - A move's position inside its small board sends the opponent to the
 *    board at that position.
 *  - If that target board is already decided, won or full, the opponent may
 *    play anywhere. Forgetting this produces a game that locks up.
 *  - A drawn small board counts for neither player but is still closed.
 *
 * The opponent scores a move by what it wins, what it blocks, which big-board
 * cell it contests, and critically **where it sends you**: handing you a board
 * where you can immediately win is a bad move regardless of what it gained.
 * That last term is what makes an Ultimate opponent feel like it is playing
 * the real game rather than nine separate small ones.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { pick } from "../lib/rng";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Overlay,
  Segmented,
  StatusLine,
  clamp,
  isTerminal,
  seedString,
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
import s from "./ultimate.module.css";

type Mark = "X" | "O";
type Cell = Mark | null;
/** A small board is won by a mark, drawn, or still open. */
type Verdict = Mark | "draw" | null;

const HUMAN: Mark = "X";
const AI: Mark = "O";
const other = (m: Mark): Mark => (m === "X" ? "O" : "X");

const LINES: number[][] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

const MODES = ["easy", "normal", "hard"] as const;
type Mode = (typeof MODES)[number];
const isMode = (v: string): v is Mode => (MODES as readonly string[]).includes(v);
const DEPTH: Record<Mode, number> = { easy: 0, normal: 0, hard: 5 };

interface Game {
  cells: Cell[]; // 81
  boards: Verdict[]; // 9
  turn: Mark;
  /** Board the current player must play in, or null when any is legal. */
  target: number | null;
  status: GameStatus;
  winner: Mark | null;
  winLine: number[] | null;
  moves: number;
  last: number | null;
}

/** Deterministic: no randomness, so it is safe in a state initialiser. */
function newGame(): Game {
  return {
    cells: new Array<Cell>(81).fill(null),
    boards: new Array<Verdict>(9).fill(null),
    turn: HUMAN,
    target: null,
    status: "playing",
    winner: null,
    winLine: null,
    moves: 0,
    last: null,
  };
}

/** Winner of a nine-cell line set, or null. Works for cells and for boards. */
function lineWinner(v: (Cell | Verdict)[]): { mark: Mark; line: number[] } | null {
  for (const line of LINES) {
    const a = v[line[0]];
    if (a !== "X" && a !== "O") continue;
    if (v[line[1]] === a && v[line[2]] === a) return { mark: a, line };
  }
  return null;
}

const boardSlice = (cells: Cell[], b: number) => cells.slice(b * 9, b * 9 + 9);

/** A board is playable when it has no verdict and still has an empty cell. */
function boardOpen(g: Game, b: number): boolean {
  if (g.boards[b] !== null) return false;
  return boardSlice(g.cells, b).some((c) => c === null);
}

/** Every legal cell index for the side to move. */
function legalMoves(g: Game): number[] {
  const out: number[] = [];
  const boards =
    g.target !== null && boardOpen(g, g.target)
      ? [g.target]
      : Array.from({ length: 9 }, (_, b) => b).filter((b) => boardOpen(g, b));
  for (const b of boards) {
    for (let c = 0; c < 9; c++) if (g.cells[b * 9 + c] === null) out.push(b * 9 + c);
  }
  return out;
}

/** Apply a move. Assumes the index is legal. */
function play(g: Game, i: number): Game {
  const cells = g.cells.slice();
  cells[i] = g.turn;
  const b = Math.floor(i / 9);
  const c = i % 9;

  const boards = g.boards.slice();
  if (boards[b] === null) {
    const slice = boardSlice(cells, b);
    const won = lineWinner(slice);
    if (won) boards[b] = won.mark;
    else if (slice.every((x) => x !== null)) boards[b] = "draw";
  }

  const big = lineWinner(boards);
  const allClosed = boards.every((v) => v !== null);

  // The move's position inside its board picks the next board. If that board
  // is already decided or full, the opponent may play anywhere.
  const nextTarget = boards[c] === null && boardSlice(cells, c).some((x) => x === null) ? c : null;

  let status: GameStatus = "playing";
  let winner: Mark | null = null;
  let winLine: number[] | null = null;
  if (big) {
    winner = big.mark;
    winLine = big.line;
    status = big.mark === HUMAN ? "won" : "over";
  } else if (allClosed) {
    status = "over";
  }

  return {
    cells,
    boards,
    turn: other(g.turn),
    target: nextTarget,
    status,
    winner,
    winLine,
    moves: g.moves + 1,
    last: i,
  };
}

/* ------------------------------------------------------------------ */
/* Opponent                                                            */
/* ------------------------------------------------------------------ */

/** Would `mark` win small board `b` with one more move? */
function canWinBoard(cells: Cell[], b: number, mark: Mark): boolean {
  const v = boardSlice(cells, b);
  for (const line of LINES) {
    const vals = line.map((k) => v[k]);
    if (vals.filter((x) => x === mark).length === 2 && vals.some((x) => x === null)) return true;
  }
  return false;
}

/** Big-board cells worth more: centre, then corners, then edges. */
const BOARD_WEIGHT = [3, 2, 3, 2, 4, 2, 3, 2, 3];

function evaluate(g: Game, me: Mark): number {
  if (g.winner === me) return 10_000;
  if (g.winner === other(me)) return -10_000;

  let score = 0;
  for (let b = 0; b < 9; b++) {
    const v = g.boards[b];
    if (v === me) score += 25 * BOARD_WEIGHT[b];
    else if (v === other(me)) score -= 25 * BOARD_WEIGHT[b];
    else if (v === null) {
      // Contest an open board by threatening to take it.
      if (canWinBoard(g.cells, b, me)) score += 6 * BOARD_WEIGHT[b];
      if (canWinBoard(g.cells, b, other(me))) score -= 7 * BOARD_WEIGHT[b];
    }
  }

  // Big-board lines that are still winnable.
  for (const line of LINES) {
    const vals = line.map((k) => g.boards[k]);
    const mine = vals.filter((x) => x === me).length;
    const theirs = vals.filter((x) => x === other(me)).length;
    if (mine > 0 && theirs > 0) continue;
    if (vals.some((x) => x === "draw")) continue;
    if (mine === 2) score += 60;
    else if (mine === 1) score += 8;
    if (theirs === 2) score -= 70;
    else if (theirs === 1) score -= 9;
  }

  return score;
}

/**
 * The term that makes the opponent feel like it understands Ultimate: a move
 * that hands the other side a board they can immediately win is penalised, and
 * one that sends them somewhere harmless is rewarded. Sending them to a free
 * choice (target null) is the worst outcome of all.
 */
function sendPenalty(next: Game, mover: Mark): number {
  const them = other(mover);
  if (next.target === null) return -30;
  if (canWinBoard(next.cells, next.target, them)) return -45;
  if (canWinBoard(next.cells, next.target, mover)) return 12;
  return 0;
}

function heuristicMove(g: Game, me: Mark): number {
  const moves = legalMoves(g);
  let bestScore = -Infinity;
  let best: number[] = [];
  for (const i of moves) {
    const next = play(g, i);
    let score = evaluate(next, me) + sendPenalty(next, me);
    // A move that closes a small board for me is worth taking now.
    const b = Math.floor(i / 9);
    if (next.boards[b] === me) score += 30 * BOARD_WEIGHT[b];
    if (score > bestScore) {
      bestScore = score;
      best = [i];
    } else if (score === bestScore) {
      best.push(i);
    }
  }
  return best.length ? pick(best) : moves[0];
}

function minimax(g: Game, depth: number, alpha: number, beta: number, me: Mark): number {
  if (isTerminal(g.status) || depth === 0) return evaluate(g, me);
  const moves = legalMoves(g);
  if (moves.length === 0) return evaluate(g, me);

  const maximising = g.turn === me;
  let value = maximising ? -Infinity : Infinity;
  let a = alpha;
  let b = beta;

  for (const i of moves) {
    const next = play(g, i);
    const inner = minimax(next, depth - 1, a, b, me) + (maximising ? sendPenalty(next, me) : 0);
    if (maximising) {
      if (inner > value) value = inner;
      if (value > a) a = value;
    } else {
      if (inner < value) value = inner;
      if (value < b) b = value;
    }
    if (b <= a) break;
  }
  return value;
}

function chooseMove(g: Game, mode: Mode): number {
  const moves = legalMoves(g);
  if (moves.length === 0) return -1;

  if (mode === "easy") {
    // Still takes a small board when one is free, so it is not pure noise.
    const winning = moves.find((i) => play(g, i).boards[Math.floor(i / 9)] === AI);
    return winning ?? pick(moves);
  }
  if (mode === "normal") return heuristicMove(g, AI);

  let bestScore = -Infinity;
  let best: number[] = [];
  for (const i of moves) {
    const next = play(g, i);
    const score = minimax(next, DEPTH.hard - 1, -Infinity, Infinity, AI) + sendPenalty(next, AI);
    if (score > bestScore) {
      bestScore = score;
      best = [i];
    } else if (score === bestScore) {
      best.push(i);
    }
  }
  return best.length ? pick(best) : moves[0];
}

/* ------------------------------------------------------------------ */
/* Marks                                                               */
/* ------------------------------------------------------------------ */

function XMark({ big }: { big?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`${s.mark} ${s.markX} ${big ? s.markBig : ""}`} aria-hidden="true">
      <path d="M6 6 L18 18" pathLength="1" />
      <path d="M18 6 L6 18" pathLength="1" />
    </svg>
  );
}

function OMark({ big }: { big?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={`${s.mark} ${s.markO} ${big ? s.markBig : ""}`} aria-hidden="true">
      <circle cx="12" cy="12" r="6.6" pathLength="1" />
    </svg>
  );
}

const Glyph = ({ mark, big }: { mark: Mark; big?: boolean }) =>
  mark === "X" ? <XMark big={big} /> : <OMark big={big} />;

/* ------------------------------------------------------------------ */

export default function UltimateTtt({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  const [mode, setMode] = useState<Mode>("normal");
  const [twoPlayer, setTwoPlayer] = useState(false);
  const [game, setGame] = useState<Game>(() => newGame());
  const [cursor, setCursor] = useState(40); // centre of the centre board
  const [series, setSeries] = useState({ you: 0, cpu: 0, drawn: 0 });
  const scored = useRef(false);
  const gameRef = useRef(game);
  gameRef.current = game;

  useEffect(() => {
    const d = seedString(seed, "difficulty");
    if (d && isMode(d)) setMode(d);
  }, [seed]);

  const reset = useCallback(() => {
    scored.current = false;
    setGame(newGame());
    setCursor(40);
  }, []);

  const changeMode = useCallback(
    (m: Mode) => {
      setMode(m);
      reset();
    },
    [reset],
  );

  // Series tally, counted once per finished game.
  useEffect(() => {
    if (!isTerminal(game.status) || scored.current) return;
    scored.current = true;
    setSeries((t) =>
      game.winner === HUMAN
        ? { ...t, you: t.you + 1 }
        : game.winner === AI
          ? { ...t, cpu: t.cpu + 1 }
          : { ...t, drawn: t.drawn + 1 },
    );
  }, [game.status, game.winner]);

  const humansTurn = twoPlayer || game.turn === HUMAN;
  const thinking = !twoPlayer && game.turn === AI && game.status === "playing";

  // The opponent moves from an effect, after a short delay so the move is
  // seen rather than appearing the instant the player lifts a finger.
  useEffect(() => {
    if (!thinking) return;
    const id = window.setTimeout(() => {
      const g = gameRef.current;
      if (g.status !== "playing" || g.turn !== AI) return;
      const move = chooseMove(g, mode);
      if (move >= 0) setGame(play(g, move));
    }, 420);
    return () => window.clearTimeout(id);
  }, [thinking, mode, game.moves]);

  const legal = useCallback(
    (i: number) => {
      if (game.status !== "playing" || !humansTurn) return false;
      if (game.cells[i] !== null) return false;
      const b = Math.floor(i / 9);
      if (!boardOpen(game, b)) return false;
      return game.target === null || game.target === b;
    },
    [game, humansTurn],
  );

  const place = useCallback(
    (i: number) => {
      if (!legal(i)) return;
      setCursor(i);
      setGame((g) => play(g, i));
    },
    [legal],
  );

  // Arrow keys walk the 81 cells as a 9x9 grid, so movement reads as one
  // surface rather than nine separate ones.
  const rcOf = (i: number) => {
    const b = Math.floor(i / 9);
    const c = i % 9;
    return { row: Math.floor(b / 3) * 3 + Math.floor(c / 3), col: (b % 3) * 3 + (c % 3) };
  };
  const indexOf = (row: number, col: number) => {
    const b = Math.floor(row / 3) * 3 + Math.floor(col / 3);
    const c = (row % 3) * 3 + (col % 3);
    return b * 9 + c;
  };

  const onDirection = useCallback(
    (dir: Direction) => {
      const { row, col } = rcOf(cursor);
      const dr = dir === "up" ? -1 : dir === "down" ? 1 : 0;
      const dc = dir === "left" ? -1 : dir === "right" ? 1 : 0;
      setCursor(indexOf(clamp(row + dr, 0, 8), clamp(col + dc, 0, 8)));
    },
    [cursor],
  );

  useDirectionKeys(onDirection, undefined, game.status === "playing");
  useKeys({ enter: () => place(cursor), r: reset }, true);

  useGameOverReport(runtime, isTerminal(game.status), () => {
    const claimed = game.boards.filter((v) => v === HUMAN).length;
    const theirs = game.boards.filter((v) => v === AI).length;
    if (game.winner === HUMAN) return `Won Ultimate Tic-Tac-Toe on ${mode} in ${game.moves} moves, ${claimed} boards to ${theirs}.`;
    if (game.winner === AI) return `Lost Ultimate Tic-Tac-Toe on ${mode} in ${game.moves} moves, ${claimed} boards to ${theirs}.`;
    return `Drew Ultimate Tic-Tac-Toe on ${mode} after ${game.moves} moves.`;
  });

  const tell = useCallback(() => {
    const verb = game.winner === HUMAN ? "beat" : game.winner === AI ? "lost to" : "drew with";
    void share(
      `I ${verb} the Ultimate Tic-Tac-Toe opponent on ${mode} in ${game.moves} moves.`,
      `Ultimate Tic-Tac-Toe series: you ${series.you}, computer ${series.cpu}, drawn ${series.drawn}.`,
    );
  }, [share, game.winner, game.moves, mode, series]);

  const overlayTitle =
    game.winner === HUMAN ? "You win" : game.winner === AI ? "Computer wins" : "Draw";

  const anyBoardLegal = game.target === null || !boardOpen(game, game.target);

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Ultimate Tic-Tac-Toe"
        stats={[
          { label: "You", value: series.you },
          { label: twoPlayer ? "Player 2" : "Computer", value: series.cpu },
          { label: "Boards", value: `${game.boards.filter((v) => v === HUMAN).length}/${game.boards.filter((v) => v === AI).length}` },
        ]}
        hint={
          game.status !== "playing"
            ? undefined
            : thinking
              ? "Computer is thinking"
              : anyBoardLegal
                ? "Play in any open board"
                : "Play in the highlighted board"
        }
      />

      <div className={s.boardWrap}>
        <div className={s.big} role="grid" aria-label="Ultimate Tic-Tac-Toe board">
          {Array.from({ length: 9 }, (_, b) => {
            const verdict = game.boards[b];
            const active = game.status === "playing" && (game.target === b || (anyBoardLegal && boardOpen(game, b)));
            const inWinLine = game.winLine?.includes(b) ?? false;
            return (
              <div
                key={b}
                className={`${s.small} ${active ? s.active : ""} ${verdict ? s.closed : ""} ${inWinLine ? s.winBoard : ""}`}
                role="row"
              >
                {Array.from({ length: 9 }, (_, c) => {
                  const i = b * 9 + c;
                  const mark = game.cells[i];
                  const playable = legal(i);
                  return (
                    <button
                      key={c}
                      type="button"
                      className={`${s.cell} ${i === cursor ? s.cursor : ""} ${playable ? s.playable : ""}`}
                      tabIndex={i === cursor ? 0 : -1}
                      disabled={!playable}
                      onFocus={() => setCursor(i)}
                      onClick={() => place(i)}
                      aria-label={`Board ${b + 1}, cell ${c + 1}${mark ? `, ${mark}` : playable ? ", playable" : ", not playable"}`}
                    >
                      {mark && <Glyph mark={mark} />}
                    </button>
                  );
                })}

                {verdict && verdict !== "draw" && (
                  <span className={s.claim} aria-hidden="true">
                    <Glyph mark={verdict} big />
                  </span>
                )}
                {verdict === "draw" && (
                  <span className={`${s.claim} ${s.claimDraw}`} aria-hidden="true">
                    &ndash;
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <Overlay
          status={game.status}
          title={overlayTitle}
          detail={`${game.moves} moves played.`}
          action="Play again"
          onAction={reset}
        />
      </div>

      <ControlBar>
        <Segmented label="Difficulty" options={MODES} value={mode} onChange={changeMode} />
        <button
          className={`${ui.btn} ${twoPlayer ? ui.primary : ""}`}
          aria-pressed={twoPlayer}
          onClick={() => {
            setTwoPlayer((v) => !v);
            reset();
          }}
        >
          Two players
        </button>
      </ControlBar>

      <ControlBar>
        <button className={`${ui.btn} ${ui.primary}`} onClick={reset}>
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
