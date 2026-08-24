/**
 * @file Connect Four against a minimax opponent with alpha-beta pruning.
 *
 * Board is `Cell[row][col]`, row 0 is the bottom so "drop into a column"
 * means "fill the lowest null row", which keeps gravity a one-line scan.
 *
 * The AI is the point of this game, so it gets the most care:
 *  - Search is plain negamax-shaped minimax with alpha-beta pruning, columns
 *    tried centre-outward (`orderedColumns`) so the cutoffs bite early.
 *  - `evaluateBoard` scores every window of four the classic way: a window
 *    that mixes both players is dead (0), one that's all empties-and-mine is
 *    worth more the fuller it is, and a bare three from the opponent is
 *    penalised harder than my own three is rewarded, because letting a
 *    three stand is how a supposedly-competent AI loses. Centre-column
 *    discs get a flat bonus on top, since centre control is what separates
 *    a real Connect Four player from one that just reacts.
 *  - A win folds `ply` into its score (`WIN_SCORE - ply`) so a mate in one
 *    always outscores a mate in three, and, symmetrically, a forced loss at
 *    a deeper ply always beats one sooner. That's what makes the AI take
 *    the fastest kill and stall the slowest death instead of being
 *    indifferent between them.
 *
 * Per the project rule against `Math.random()` in state initialisers,
 * `newGame` is fully deterministic (human always drops first into an empty
 * board). Randomness only enters `chooseAiMove`, which runs from an effect
 * in response to a real turn change, never from render.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  DPad,
  GameFrame,
  GameHeader,
  Overlay,
  Segmented,
  StandardControls,
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
import { pick } from "../lib/rng";
import type { AppProps } from "../lib/runtime";
import s from "./connectfour.module.css";

const ROWS = 6;
const COLS = 7;

type Player = 1 | 2;
type Cell = Player | null;
type Board = Cell[][]; // Board[row][col], row 0 = bottom

const HUMAN: Player = 1;
const AI: Player = 2;
const other = (p: Player): Player => (p === HUMAN ? AI : HUMAN);

const DIFFICULTIES = ["easy", "normal", "hard", "expert"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];
const isDifficulty = (v: string): v is Difficulty => (DIFFICULTIES as readonly string[]).includes(v);
const DEPTH_BY_DIFFICULTY: Record<Difficulty, number> = { easy: 2, normal: 4, hard: 6, expert: 8 };

/** Disc colours are game content, not theme. A faint ring on the AI's disc
 * keeps the two apart for a viewer who can't rely on hue alone. */
const DISC: Record<Player, { label: string; bg: string; hi: string; sh: string; ring: string }> = {
  [HUMAN]: { label: "Red", bg: "#dc2626", hi: "#f87171", sh: "#7f1d1d", ring: "transparent" },
  [AI]: { label: "Yellow", bg: "#eab308", hi: "#fde047", sh: "#854d0e", ring: "rgba(120, 53, 15, 0.55)" },
};

interface Move {
  row: number;
  col: number;
  player: Player;
}

interface GameState {
  board: Board;
  turn: Player;
  status: GameStatus; // only ever "playing" | "won" | "over" in this game
  winner: Player | null;
  winCells: [number, number][] | null;
  lastMove: Move | null;
  moves: number;
}

const emptyBoard = (): Board => Array.from({ length: ROWS }, () => new Array<Cell>(COLS).fill(null));

/** Deterministic fresh game, no randomness, so it's safe in a state initialiser. */
function newGame(): GameState {
  return {
    board: emptyBoard(),
    turn: HUMAN,
    status: "playing",
    winner: null,
    winCells: null,
    lastMove: null,
    moves: 0,
  };
}

const getDropRow = (board: Board, col: number): number => {
  for (let row = 0; row < ROWS; row++) if (board[row][col] === null) return row;
  return -1;
};

const isColumnFull = (board: Board, col: number): boolean => board[ROWS - 1][col] !== null;
const isBoardFull = (board: Board): boolean => board[ROWS - 1].every((c) => c !== null);

function withDisc(board: Board, row: number, col: number, player: Player): Board {
  const next = board.map((r) => r.slice());
  next[row][col] = player;
  return next;
}

/** Columns to try centre-first, e.g. [3,2,4,1,5,0,6] for 7 columns. Move
 * ordering like this is what makes alpha-beta pruning actually pay off. */
function orderedColumns(cols: number): number[] {
  const center = Math.floor(cols / 2);
  const order = [center];
  for (let d = 1; d <= center; d++) {
    if (center - d >= 0) order.push(center - d);
    if (center + d < cols) order.push(center + d);
  }
  return order;
}

/**
 * Four-in-a-row check anchored on the disc just placed at (row, col). Walks
 * each of the four axes (horizontal, vertical, both diagonals) outward in
 * both directions, then returns a four-cell window from that run that is
 * guaranteed to include the placed disc, so a run longer than four still
 * highlights a legitimate winning line through the move that made it.
 */
function checkWinAt(board: Board, row: number, col: number, player: Player): [number, number][] | null {
  const axes: [number, number][] = [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ];
  for (const [dr, dc] of axes) {
    const run: [number, number][] = [[row, col]];
    let placedIndex = 0;
    let r = row - dr;
    let c = col - dc;
    while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === player) {
      run.unshift([r, c]);
      placedIndex++;
      r -= dr;
      c -= dc;
    }
    r = row + dr;
    c = col + dc;
    while (r >= 0 && r < ROWS && c >= 0 && c < COLS && board[r][c] === player) {
      run.push([r, c]);
      r += dr;
      c += dc;
    }
    if (run.length >= 4) {
      const start = Math.max(0, Math.min(placedIndex - 3, run.length - 4));
      return run.slice(start, start + 4) as [number, number][];
    }
  }
  return null;
}

/**
 * Score one window of four cells from `player`'s perspective. A window that
 * already holds both colours is dead (0): no four can ever land there. An
 * opponent three-with-a-gap is weighted well past a symmetric three of my
 * own, because failing to block it loses outright while failing to press it
 * merely delays a win.
 */
function windowScore(window: Cell[], player: Player): number {
  const opp = other(player);
  let mine = 0;
  let theirs = 0;
  for (const cell of window) {
    if (cell === player) mine++;
    else if (cell === opp) theirs++;
  }
  if (mine > 0 && theirs > 0) return 0;
  const empty = 4 - mine - theirs;
  if (mine === 4) return 100_000;
  if (mine === 3 && empty === 1) return 50;
  if (mine === 2 && empty === 2) return 8;
  if (mine === 1 && empty === 3) return 1;
  if (theirs === 3 && empty === 1) return -80;
  if (theirs === 2 && empty === 2) return -4;
  return 0;
}

/** Sum every horizontal, vertical and diagonal window, plus a centre-column
 * control bonus. Centre discs sit in more potential windows than any other
 * column, so rewarding them directly is what makes the AI fight for the
 * middle instead of drifting to the edges. */
function evaluateBoard(board: Board, player: Player): number {
  let score = 0;

  const centerCol = Math.floor(COLS / 2);
  for (let row = 0; row < ROWS; row++) if (board[row][centerCol] === player) score += 6;

  for (let row = 0; row < ROWS; row++) {
    for (let c = 0; c <= COLS - 4; c++) {
      score += windowScore([board[row][c], board[row][c + 1], board[row][c + 2], board[row][c + 3]], player);
    }
  }
  for (let c = 0; c < COLS; c++) {
    for (let row = 0; row <= ROWS - 4; row++) {
      score += windowScore([board[row][c], board[row + 1][c], board[row + 2][c], board[row + 3][c]], player);
    }
  }
  for (let row = 0; row <= ROWS - 4; row++) {
    for (let c = 0; c <= COLS - 4; c++) {
      score += windowScore(
        [board[row][c], board[row + 1][c + 1], board[row + 2][c + 2], board[row + 3][c + 3]],
        player,
      );
      score += windowScore(
        [board[row + 3][c], board[row + 2][c + 1], board[row + 1][c + 2], board[row][c + 3]],
        player,
      );
    }
  }
  return score;
}

const WIN_SCORE = 1_000_000;

interface SearchResult {
  score: number;
  col: number | null;
}

/** Alpha-beta minimax. `aiPlayer` is fixed for the whole search (the side we
 * are scoring for); `maximizing` flips each ply. `ply` counts moves from the
 * root so a win or loss score can be discounted by how far away it is. */
function minimax(
  board: Board,
  depth: number,
  alpha: number,
  beta: number,
  maximizing: boolean,
  aiPlayer: Player,
  ply: number,
  lastMove: Move | null,
): SearchResult {
  if (lastMove && checkWinAt(board, lastMove.row, lastMove.col, lastMove.player)) {
    const score = lastMove.player === aiPlayer ? WIN_SCORE - ply : -(WIN_SCORE - ply);
    return { score, col: lastMove.col };
  }

  const cols = orderedColumns(COLS).filter((c) => getDropRow(board, c) !== -1);
  if (cols.length === 0) return { score: 0, col: null }; // draw
  if (depth === 0) return { score: evaluateBoard(board, aiPlayer), col: null };

  const mover = maximizing ? aiPlayer : other(aiPlayer);
  let bestCol = cols[0];
  let value = maximizing ? -Infinity : Infinity;

  for (const col of cols) {
    const row = getDropRow(board, col);
    const nextBoard = withDisc(board, row, col, mover);
    const result = minimax(nextBoard, depth - 1, alpha, beta, !maximizing, aiPlayer, ply + 1, {
      row,
      col,
      player: mover,
    });
    if (maximizing ? result.score > value : result.score < value) {
      value = result.score;
      bestCol = col;
    }
    if (maximizing) alpha = Math.max(alpha, value);
    else beta = Math.min(beta, value);
    if (alpha >= beta) break;
  }
  return { score: value, col: bestCol };
}

/** Easy difficulty occasionally drops a deliberately weak move instead of
 * the searched best one, so it actually feels easy rather than just shallow. */
function chooseAiMove(board: Board, difficulty: Difficulty): number {
  const cols = orderedColumns(COLS).filter((c) => getDropRow(board, c) !== -1);
  if (cols.length === 0) return -1;
  if (difficulty === "easy" && Math.random() < 0.3) return pick(cols);
  const depth = DEPTH_BY_DIFFICULTY[difficulty];
  const result = minimax(board, depth, -Infinity, Infinity, true, AI, 0, null);
  return result.col ?? pick(cols);
}

export default function ConnectFour({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const seed = useSeed(runtime);
  const seedDifficulty = seedString(seed, "difficulty", "normal");
  const initialDifficulty: Difficulty = isDifficulty(seedDifficulty) ? seedDifficulty : "normal";

  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [game, setGame] = useState<GameState>(() => newGame());
  const gameRef = useRef(game);
  const [cursor, setCursor] = useState(Math.floor(COLS / 2));
  const [hoverCol, setHoverCol] = useState<number | null>(null);
  const [series, setSeries] = useState({ you: 0, computer: 0 });
  const aiTimer = useRef<number | undefined>(undefined);

  const commit = useCallback((next: GameState) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  // Seed difficulty lands after mount (maybe). Sync once when it first
  // differs from the placeholder default; a later manual Segmented pick is
  // left alone because the seed value itself doesn't change again.
  useEffect(() => {
    setDifficulty(initialDifficulty);
  }, [initialDifficulty]);

  const reset = useCallback(() => {
    if (aiTimer.current) {
      window.clearTimeout(aiTimer.current);
      aiTimer.current = undefined;
    }
    commit(newGame());
    setCursor(Math.floor(COLS / 2));
  }, [commit]);

  const changeDifficulty = useCallback(
    (d: Difficulty) => {
      setDifficulty(d);
      reset();
    },
    [reset],
  );

  /** Land one disc for `player`, and settle the resulting game state (win,
   * draw, or hand-off to the other player). The only place the board mutates. */
  const dropAt = useCallback(
    (col: number, player: Player) => {
      const g = gameRef.current;
      if (g.status !== "playing") return;
      const row = getDropRow(g.board, col);
      if (row === -1) return;

      const board = withDisc(g.board, row, col, player);
      const moves = g.moves + 1;
      const lastMove: Move = { row, col, player };
      const winCells = checkWinAt(board, row, col, player);

      if (winCells) {
        commit({ board, turn: other(player), status: player === HUMAN ? "won" : "over", winner: player, winCells, lastMove, moves });
        setSeries((s2) => (player === HUMAN ? { ...s2, you: s2.you + 1 } : { ...s2, computer: s2.computer + 1 }));
        return;
      }
      if (isBoardFull(board)) {
        commit({ board, turn: other(player), status: "over", winner: null, winCells: null, lastMove, moves });
        return;
      }
      commit({ board, turn: other(player), status: "playing", winner: null, winCells: null, lastMove, moves });
    },
    [commit],
  );

  const humanDrop = useCallback(
    (col: number) => {
      const g = gameRef.current;
      if (g.status !== "playing" || g.turn !== HUMAN) return;
      if (getDropRow(g.board, col) === -1) return;
      dropAt(col, HUMAN);
    },
    [dropAt],
  );

  // AI's turn: a deliberate ~400ms "thinking" pause before the search even
  // runs. The search itself is well under 100ms at any difficulty, but an
  // instant reply feels wrong and steals the moment from the drop animation.
  useEffect(() => {
    if (game.status !== "playing" || game.turn !== AI) return;
    aiTimer.current = window.setTimeout(() => {
      const g = gameRef.current;
      if (g.status !== "playing" || g.turn !== AI) return;
      const col = chooseAiMove(g.board, difficulty);
      if (col >= 0) dropAt(col, AI);
    }, 400);
    return () => {
      if (aiTimer.current) window.clearTimeout(aiTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game.status, game.turn, game.moves, difficulty, dropAt]);

  const moveCursor = useCallback((delta: number) => {
    setCursor((c) => clamp(c + delta, 0, COLS - 1));
  }, []);

  const onDirection = (dir: Direction) => {
    if (dir === "left") moveCursor(-1);
    else if (dir === "right") moveCursor(1);
    else if (dir === "down") humanDrop(cursor);
  };
  useDirectionKeys(onDirection);
  useKeys({ enter: () => humanDrop(cursor) });

  const won = game.status === "won";
  const draw = game.status === "over" && game.winner === null;

  useGameOverReport(runtime, isTerminal(game.status), () => {
    if (won) return `Connect Four: you beat the computer on ${difficulty} difficulty in ${game.moves} moves.`;
    if (draw) return `Connect Four ended in a draw on ${difficulty} difficulty after ${game.moves} moves.`;
    return `Connect Four: the computer beat you on ${difficulty} difficulty in ${game.moves} moves.`;
  });

  const [shareStatus, share] = useShare(runtime);
  const tell = useCallback(() => {
    const message = draw
      ? `I drew with the Connect Four AI on ${difficulty} in ${game.moves} moves.`
      : `I ${won ? "beat" : "lost to"} the Connect Four AI on ${difficulty} in ${game.moves} moves.`;
    void share(
      message,
      `Connect Four ${game.status}: winner ${game.winner ?? "none"}, ${game.moves} moves, ${difficulty} difficulty.`,
    );
  }, [share, draw, won, difficulty, game.moves, game.status, game.winner]);

  const overlayTitle = won ? "You win" : draw ? "Draw" : game.status === "over" ? "Computer wins" : undefined;
  const activeCol = hoverCol ?? cursor;
  const humansTurn = game.status === "playing" && game.turn === HUMAN;

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide>
      <GameHeader
        title="Connect Four"
        stats={[
          { label: "You", value: series.you },
          { label: "Computer", value: series.computer },
          { label: "Moves", value: game.moves },
        ]}
        hint={game.status === "playing" ? (game.turn === HUMAN ? "Your turn" : "Computer is thinking…") : undefined}
      />

      <div className={s.boardWrap}>
        <div className={s.board} role="group" aria-label="Connect Four board">
          {Array.from({ length: COLS }, (_, col) => {
            const filled = isColumnFull(game.board, col);
            const active = activeCol === col;
            return (
              <button
                key={col}
                type="button"
                className={`${s.column} ${active ? s.columnActive : ""}`}
                disabled={!humansTurn || filled}
                onClick={() => {
                  setCursor(col);
                  humanDrop(col);
                }}
                onMouseEnter={() => setHoverCol(col)}
                onMouseLeave={() => setHoverCol(null)}
                onFocus={() => setCursor(col)}
                aria-label={`Column ${col + 1}${filled ? ", full" : ""}`}
              >
                {active && humansTurn && (
                  <span className={s.ghost} style={sv({ "--bg": DISC[HUMAN].bg })} aria-hidden="true" />
                )}
                {Array.from({ length: ROWS }, (_, v) => ROWS - 1 - v).map((row) => {
                  const cell = game.board[row][col];
                  const isWinning = game.winCells?.some(([wr, wc]) => wr === row && wc === col) ?? false;
                  const dim = game.winCells != null && !isWinning;
                  return (
                    <div key={row} className={s.cell}>
                      {cell && (
                        <span
                          className={`${s.disc} ${isWinning ? s.discWin : ""} ${dim ? s.discDim : ""}`}
                          style={sv({
                            "--bg": DISC[cell].bg,
                            "--hi": DISC[cell].hi,
                            "--sh": DISC[cell].sh,
                            "--ring": DISC[cell].ring,
                            "--fall": ROWS - row,
                          })}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  );
                })}
              </button>
            );
          })}
        </div>

        <Overlay
          status={game.status}
          title={overlayTitle}
          detail={isTerminal(game.status) ? `${game.moves} move${game.moves === 1 ? "" : "s"} played.` : undefined}
          action={isTerminal(game.status) ? "Play again" : undefined}
          onAction={isTerminal(game.status) ? reset : undefined}
        />
      </div>

      {/* Column cursor and drop sit together: on touch, moving and dropping are
          one gesture, and splitting them across two rows put a gap between the
          two halves of a single action. */}
      <div className={s.dropRow}>
        <DPad onDirection={onDirection} hide="vertical" />
        <button
          type="button"
          className={s.dropButton}
          onClick={() => humanDrop(cursor)}
          disabled={!humansTurn || isColumnFull(game.board, cursor)}
        >
          Drop
        </button>
      </div>

      <div className={s.difficultyRow}>
        <Segmented label="Difficulty" options={DIFFICULTIES} value={difficulty} onChange={changeDifficulty} />
      </div>

      <StandardControls
        status={game.status}
        onRestart={reset}
        fullscreen={isFull}
        onFullscreen={toggleFull}
        onShare={tell}
      />

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
