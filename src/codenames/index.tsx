/**
 * @file Solo Codenames. The model is the spymaster, the player is the field
 * operative.
 *
 * One invariant carries the whole game: the key never reaches the DOM. Roles
 * live in component state, and a cell's role is only rendered, classed or
 * labelled once that cell has been guessed. The flip is built from a back face
 * that stays empty until the guess lands, so no unrevealed role is sitting in
 * the markup waiting to be read out of devtools.
 *
 * Protocol. The model opens the app with `words`, `key`, `clue` and `count`,
 * and the player gets `count + 1` guesses. When the turn ends the app reports
 * what happened through `share` and asks for the next clue. That costs a model
 * turn, which the shell normally warns against, but here the exchange is the
 * game loop itself, and every send follows a card or a button the player
 * pressed.
 *
 * Seed handling is deliberately sticky. The board is replaced only when a
 * genuinely different grid arrives, so a resent notification, or a follow-up
 * call carrying only the next clue, leaves the revealed cards alone. With no
 * valid board the app waits and offers to ask for one. It never deals its own,
 * because a self-dealt board has no spymaster.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  StatusLine,
  clamp,
  isTerminal,
  seedArray,
  seedNumber,
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
import s from "./codenames.module.css";

const SIZE = 5;
const CELLS = SIZE * SIZE;

/** A agent, B bystander, X assassin: exactly the letters the model is asked for. */
type Role = "A" | "B" | "X";

/** `waiting` locks the grid pending a clue, `done` is terminal. */
type Phase = "waiting" | "playing" | "done";

interface Board {
  words: string[];
  roles: Role[];
}

const ROLE_NAME: Record<Role, string> = { A: "agent", B: "bystander", X: "assassin" };
const ROLE_CLASS: Record<Role, string> = { A: s.agent, B: s.bystander, X: s.assassin };

const SETUP_REQUEST =
  "Set up a Codenames board: 25 single words, a 25-letter key with 9 A, 15 B and 1 X, and your first clue.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Read a playable board out of the seed, or null. Anything short of 25 usable
 * words, 25 usable role letters and at least one agent is not a board, and the
 * app waits rather than filling in the missing half itself.
 */
function readBoard(seed: Record<string, unknown>): Board | null {
  const words = seedArray<unknown>(seed, "words").filter(
    (w): w is string => typeof w === "string" && w.trim().length > 0,
  );
  const roles = seedArray<unknown>(seed, "key").filter(
    (k): k is Role => k === "A" || k === "B" || k === "X",
  );
  if (words.length !== CELLS || roles.length !== CELLS) return null;
  if (!roles.includes("A")) return null;
  return { words, roles };
}

/** Long codenames have to shrink to fit a fifth of the grid. */
const fontScale = (word: string) => (word.length <= 6 ? 1 : word.length <= 9 ? 0.84 : 0.66);

/** Local mark: there is no shared spy icon, and the bundle allows no images. */
const SpyIcon = () => (
  <svg viewBox="0 0 24 24" className={s.titleIcon} aria-hidden="true">
    <path
      d="M3.5 8.5h17l-1.7 3.4a3 3 0 0 1-2.7 1.7H7.9a3 3 0 0 1-2.7-1.7L3.5 8.5Z"
      fill="currentColor"
      opacity="0.5"
    />
    <path d="M7.8 3h8.4l1.7 4.5H6.1L7.8 3Z" fill="currentColor" />
    <circle cx="8.6" cy="17.6" r="2.6" fill="currentColor" />
    <circle cx="15.4" cy="17.6" r="2.6" fill="currentColor" />
  </svg>
);

export default function Codenames({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  const incoming = useMemo(() => readBoard(seed), [seed]);
  const clue = seedString(seed, "clue");
  const count = seedNumber(seed, "count", 1, 1, 9);

  const [board, setBoard] = useState<Board | null>(null);
  const [revealed, setRevealed] = useState<boolean[]>(() => Array<boolean>(CELLS).fill(false));
  const [phase, setPhase] = useState<Phase>("waiting");
  const [status, setStatus] = useState<GameStatus>("playing");
  const [guessesLeft, setGuessesLeft] = useState(0);
  const [turns, setTurns] = useState(0);
  const [event, setEvent] = useState("");
  const [cursor, setCursor] = useState(0);

  // Signatures of what has already been consumed. Refs, never state, so that no
  // part of them can reach the markup: `boardSig` contains the key.
  const boardSig = useRef("");
  const clueSig = useRef("");
  const gridRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef(0);

  // A new deal resets everything. An identical redelivery does not, which is
  // what stops a reconnect from re-flipping cards the player already turned.
  useEffect(() => {
    if (!incoming) return;
    const sig = `${incoming.words.join(" ")}|${incoming.roles.join("")}`;
    if (sig === boardSig.current) return;
    boardSig.current = sig;
    clueSig.current = "";
    setBoard(incoming);
    setRevealed(Array<boolean>(CELLS).fill(false));
    setPhase("waiting");
    setStatus("playing");
    setGuessesLeft(0);
    setTurns(0);
    setEvent("");
    setCursor(0);
    cursorRef.current = 0;
  }, [incoming]);

  const startTurn = useCallback((covers: number) => {
    setGuessesLeft(covers + 1);
    setTurns((t) => t + 1);
    setPhase("playing");
    setEvent("");
  }, []);

  // A clue the app has not played yet opens a turn.
  useEffect(() => {
    if (!board || !clue || phase === "done") return;
    const sig = `${clue}|${count}`;
    if (sig === clueSig.current) return;
    clueSig.current = sig;
    startTurn(count);
  }, [board, clue, count, phase, startTurn]);

  const roles = board?.roles;
  const agentTotal = useMemo(
    () => (roles ? roles.reduce((n, r) => n + (r === "A" ? 1 : 0), 0) : 0),
    [roles],
  );
  const found = useMemo(
    () => (roles ? roles.reduce((n, r, i) => n + (r === "A" && revealed[i] ? 1 : 0), 0) : 0),
    [roles, revealed],
  );
  const wrong = useMemo(
    () => (roles ? roles.reduce((n, r, i) => n + (r !== "A" && revealed[i] ? 1 : 0), 0) : 0),
    [roles, revealed],
  );
  const agentsLeft = agentTotal - found;
  const perfect = status === "won" && wrong === 0;

  const endTurn = useCallback(
    (report: string, left: number, missed: number) => {
      setPhase("waiting");
      setGuessesLeft(0);
      void share(
        report,
        `Codenames: ${plural(left, "agent", "agents")} left, ${plural(missed, "wrong guess", "wrong guesses")}.`,
      );
    },
    [share],
  );

  const guess = useCallback(
    (i: number) => {
      if (!board || phase !== "playing" || revealed[i]) return;
      const role = board.roles[i];
      const word = board.words[i].toUpperCase();
      const next = revealed.slice();
      next[i] = true;
      setRevealed(next);

      const nowFound = board.roles.reduce((n, r, j) => n + (r === "A" && next[j] ? 1 : 0), 0);
      const nowWrong = board.roles.reduce((n, r, j) => n + (r !== "A" && next[j] ? 1 : 0), 0);
      const left = Math.max(0, guessesLeft - 1);
      setGuessesLeft(left);

      if (role === "X") {
        setPhase("done");
        setStatus("over");
        setEvent(`${word} was the assassin.`);
        return;
      }
      if (role === "B") {
        setEvent(`${word} was a bystander. Turn over.`);
        endTurn(
          `I guessed "${word}" and hit a bystander. Next clue please.`,
          agentTotal - nowFound,
          nowWrong,
        );
        return;
      }
      if (nowFound >= agentTotal) {
        setPhase("done");
        setStatus("won");
        setEvent(`${word} was an agent. All ${agentTotal} found.`);
        return;
      }
      if (left === 0) {
        setEvent(`${word} was an agent, and that was the last guess.`);
        endTurn(
          `I guessed "${word}", another agent, and that was my last guess. Next clue please.`,
          agentTotal - nowFound,
          nowWrong,
        );
        return;
      }
      setEvent(`${word} was an agent. ${plural(left, "guess", "guesses")} left.`);
    },
    [board, phase, revealed, guessesLeft, agentTotal, endTurn],
  );

  const pass = useCallback(() => {
    if (!board || phase !== "playing") return;
    setEvent("Turn passed.");
    endTurn("I will stop guessing there. Next clue please.", agentsLeft, wrong);
  }, [board, phase, agentsLeft, wrong, endTurn]);

  const askForBoard = useCallback(() => void share(SETUP_REQUEST), [share]);

  useGameOverReport(runtime, isTerminal(status), () =>
    status === "won"
      ? `Codenames won. All ${agentTotal} agents found in ${plural(turns, "turn", "turns")} with ${plural(wrong, "wrong guess", "wrong guesses")}.${perfect ? " A perfect game." : ""}`
      : `Codenames lost to the assassin. ${found} of ${agentTotal} agents found in ${plural(turns, "turn", "turns")}.`,
  );

  // Roving tabindex: one cell is tabbable, arrows move the cursor, and DOM
  // focus follows only when the player is already inside the grid.
  const move = useCallback((dir: Direction) => {
    const c = cursorRef.current;
    const row = clamp(
      Math.floor(c / SIZE) + (dir === "up" ? -1 : dir === "down" ? 1 : 0),
      0,
      SIZE - 1,
    );
    const col = clamp((c % SIZE) + (dir === "left" ? -1 : dir === "right" ? 1 : 0), 0, SIZE - 1);
    const n = row * SIZE + col;
    if (n === c) return;
    cursorRef.current = n;
    setCursor(n);
    const host = gridRef.current;
    if (host && host.contains(document.activeElement)) {
      host.querySelectorAll<HTMLButtonElement>("button")[n]?.focus();
    }
  }, []);

  const live = Boolean(board) && !isTerminal(status);
  useDirectionKeys(move, undefined, live);
  useKeys({ enter: () => guess(cursorRef.current), escape: pass }, live);

  const syncCursor = useCallback((i: number) => {
    cursorRef.current = i;
    setCursor(i);
  }, []);

  const header = (
    <GameHeader
      title="Codenames"
      icon={<SpyIcon />}
      stats={
        board
          ? [
              { label: "Agents", value: `${found} of ${agentTotal}` },
              { label: "Guesses left", value: guessesLeft },
              { label: "Turns", value: turns },
            ]
          : undefined
      }
      hint={board ? undefined : "The model is your spymaster."}
    />
  );

  if (!board) {
    return (
      <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
        {header}
        <div className={s.setup}>
          <div className={s.ghostGrid} aria-hidden="true">
            {Array.from({ length: CELLS }, (_, i) => (
              <span key={i} className={s.ghost} style={sv({ "--i": i })} />
            ))}
          </div>
          <p className={s.setupText}>
            No board yet. Your spymaster deals 25 words, keeps the key secret, and sends the first
            clue.
          </p>
          <ControlBar>
            <button className={`${ui.btn} ${ui.primary}`} onClick={askForBoard}>
              Ask for a board
            </button>
          </ControlBar>
          {runtime.standalone && <Notice>Standalone preview: no spymaster is listening.</Notice>}
        </div>
        <StatusLine>{shareStatus}</StatusLine>
      </GameFrame>
    );
  }

  const locked = phase !== "playing";

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      {header}

      <div className={s.transmission}>
        <span className={s.transLabel}>Spymaster</span>
        {phase === "playing" && clue ? (
          <span className={s.clueRow}>
            <b className={s.clueWord}>{clue}</b>
            <span className={s.clueCount} aria-hidden="true">
              {count}
            </span>
            <span className={s.sr}>for {plural(count, "word", "words")}</span>
          </span>
        ) : (
          <span className={s.awaiting}>
            <span className={s.blip} aria-hidden="true" />
            {turns === 0 ? "Awaiting the first clue" : "Awaiting the next clue"}
          </span>
        )}
        <span className={s.transMeta}>
          {phase === "playing"
            ? `${plural(guessesLeft, "guess", "guesses")} left this turn`
            : `${plural(agentsLeft, "agent", "agents")} still in the field`}
        </span>
      </div>

      <div className={s.boardWrap}>
        <div
          ref={gridRef}
          className={`${s.grid} ${locked ? s.locked : ""}`}
          role="grid"
          aria-label="Codenames grid"
          aria-rowcount={SIZE}
          aria-colcount={SIZE}
        >
          {Array.from({ length: SIZE }, (_, r) => (
            <div className={s.row} role="row" key={r}>
              {Array.from({ length: SIZE }, (_, c) => {
                const i = r * SIZE + c;
                const word = board.words[i];
                const shown = revealed[i];
                // Read the role ONLY for a revealed cell. Nothing below this
                // line may touch `board.roles` in any other case: class names,
                // labels and text content all hang off `role`, which is null
                // until the player has turned the card over.
                const role = shown ? board.roles[i] : null;
                return (
                  <div className={s.cellWrap} role="gridcell" key={c}>
                    <button
                      type="button"
                      className={`${s.card} ${shown ? s.flipped : ""} ${i === cursor ? s.cursor : ""}`}
                      style={sv({ "--fs": fontScale(word) })}
                      tabIndex={i === cursor ? 0 : -1}
                      aria-disabled={shown || locked}
                      aria-label={
                        role ? `${word}, revealed ${ROLE_NAME[role]}` : `${word}, not revealed`
                      }
                      onFocus={() => syncCursor(i)}
                      onClick={() => guess(i)}
                    >
                      <span className={s.inner}>
                        <span className={`${s.face} ${s.front}`}>{word}</span>
                        <span className={`${s.face} ${s.back} ${role ? ROLE_CLASS[role] : ""}`}>
                          {role && (
                            <>
                              <span className={s.backWord}>{word}</span>
                              <span className={s.roleTag}>{ROLE_NAME[role]}</span>
                            </>
                          )}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))}
        </div>

        <Overlay
          status={status}
          title={status === "won" ? (perfect ? "Perfect game" : "All agents found") : "Assassin"}
          detail={
            status === "won"
              ? `${plural(turns, "turn", "turns")}, ${plural(wrong, "wrong guess", "wrong guesses")}.`
              : `${found} of ${agentTotal} agents found in ${plural(turns, "turn", "turns")}.`
          }
          action="New board"
          onAction={askForBoard}
        />
      </div>

      <ControlBar>
        <button className={`${ui.btn} ${ui.primary}`} onClick={pass} disabled={locked}>
          Pass turn
        </button>
        {phase === "waiting" && clue !== "" && turns > 0 && (
          <button className={ui.btn} onClick={() => startTurn(count)}>
            Replay that clue
          </button>
        )}
        <button className={ui.btn} onClick={askForBoard}>
          New board
        </button>
        <button className={ui.btn} onClick={toggleFull}>
          {isFull ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </ControlBar>

      <Notice>Tap a card to guess. Arrows move, Enter guesses, Escape passes.</Notice>
      <StatusLine>{shareStatus || event}</StatusLine>
    </GameFrame>
  );
}
