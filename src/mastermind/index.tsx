/**
 * @file Mastermind: break a hidden colour code from black/white peg feedback.
 *
 * The code lives only in `game.code` and is read in exactly one place, the
 * end-of-game reveal gated on `isTerminal(status)`. Nothing else in this file
 * ever indexes into it, so it can't leak into a class name, an aria-label or a
 * console log by accident. `reset` sets it back to `null` synchronously, so a
 * restart can't show stale state from the previous game either.
 *
 * Per the project rule against `Math.random()` in state initialisers (React
 * StrictMode double-invokes them, which would hand the two passes different
 * codes), `newGame` never generates a code. `submitGuess` generates one lazily
 * the first time it is needed. That function only ever runs from a real click
 * or key press, never from render, so the double-invoke problem doesn't apply
 * to it.
 *
 * Placing a peg supports both a touch-first flow (tap a slot to cycle through
 * colours) and a mouse-first flow (tap a palette swatch to select it, then tap
 * slots to stamp it in) through the same handler: a slot tap consults whether
 * a palette colour is selected and either stamps or cycles.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ControlBar,
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
  useBest,
  useFullscreen,
  useGameOverReport,
  useKeys,
  useSeed,
  useShare,
  type GameStatus,
} from "../lib/game";
import { randInt, shuffle } from "../lib/rng";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./mastermind.module.css";

/**
 * Colour-vision-safe palette (Okabe-Ito, minus black which would be confused
 * with the "black peg" feedback marker, plus one charcoal to reach eight).
 * Every peg also carries a letter, so colour is never the only signal.
 */
interface PegColour {
  name: string;
  letter: string;
  bg: string;
  ink: string;
}
const PALETTE: PegColour[] = [
  { name: "Orange", letter: "O", bg: "#e69f00", ink: "#3a2400" },
  { name: "Sky blue", letter: "S", bg: "#56b4e9", ink: "#063247" },
  { name: "Green", letter: "G", bg: "#009e73", ink: "#f2fff9" },
  { name: "Yellow", letter: "Y", bg: "#f0e442", ink: "#3a3200" },
  { name: "Blue", letter: "B", bg: "#0072b2", ink: "#f2f8ff" },
  { name: "Vermillion", letter: "V", bg: "#d55e00", ink: "#fff3e9" },
  { name: "Purple", letter: "P", bg: "#cc79a7", ink: "#3a0f22" },
  { name: "Charcoal", letter: "K", bg: "#4b4b4b", ink: "#f5f5f5" },
];

const DIFFICULTIES = ["easy", "normal", "hard", "expert"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];
const isDifficulty = (v: string): v is Difficulty => (DIFFICULTIES as readonly string[]).includes(v);

interface DifficultyConfig {
  length: number;
  colours: number;
  repeats: boolean;
  guesses: number;
}
const DIFFICULTY_CONFIG: Record<Difficulty, DifficultyConfig> = {
  easy: { length: 4, colours: 6, repeats: false, guesses: 10 },
  normal: { length: 4, colours: 6, repeats: true, guesses: 10 },
  hard: { length: 5, colours: 7, repeats: true, guesses: 10 },
  expert: { length: 5, colours: 8, repeats: true, guesses: 8 },
};

interface Feedback {
  black: number;
  white: number;
}
interface HistoryEntry {
  pegs: number[];
  feedback: Feedback;
}
interface Game {
  difficulty: Difficulty;
  length: number;
  colours: number;
  repeats: boolean;
  maxGuesses: number;
  /** Hidden until reveal. Deliberately absent from every other render path. */
  code: number[] | null;
  history: HistoryEntry[];
  current: (number | null)[];
  status: GameStatus; // only ever "playing" | "won" | "over" in this game
}

/** Deterministic fresh game, no randomness, so it's safe in a state initialiser. */
function newGame(difficulty: Difficulty): Game {
  const cfg = DIFFICULTY_CONFIG[difficulty];
  return {
    difficulty,
    length: cfg.length,
    colours: cfg.colours,
    repeats: cfg.repeats,
    maxGuesses: cfg.guesses,
    code: null,
    history: [],
    current: new Array(cfg.length).fill(null),
    status: "playing",
  };
}

/** Called once, lazily, from the first submit. Never from render. */
function generateCode(length: number, colours: number, repeats: boolean): number[] {
  if (repeats) return Array.from({ length }, () => randInt(0, colours - 1));
  return shuffle(Array.from({ length: colours }, (_, i) => i)).slice(0, length);
}

/**
 * Classic Mastermind scoring. Blacks are exact position matches. Whites count
 * colour overlap without reusing a peg that already scored black: sum, per
 * colour, the smaller of how many times it appears in the guess and in the
 * code, add those up across every colour, then subtract the blacks (an exact
 * match is counted once in that overlap sum and must not also count as white).
 *
 * Sanity check by hand: code [0,0,1,1], guess [0,1,0,1].
 *  - Position 0 and position 3 match -> black = 2.
 *  - Colour 0 appears twice in each -> min(2,2) = 2. Colour 1 appears twice in
 *    each -> min(2,2) = 2. Overlap total = 4.
 *  - white = 4 - 2 = 2, which is right: the leftover guess digits (1, 0) each
 *    find a leftover code slot of the same colour.
 * Second check: code [0,1,2,3], guess [3,2,1,0] (fully displaced permutation).
 *  - No position matches -> black = 0.
 *  - Every colour appears once in both -> overlap total = 4.
 *  - white = 4 - 0 = 4, which is right: every peg is the right colour, wrong spot.
 */
function scoreGuess(guess: number[], code: number[]): Feedback {
  let black = 0;
  for (let i = 0; i < guess.length; i++) if (guess[i] === code[i]) black++;

  const guessCounts = new Array(PALETTE.length).fill(0);
  const codeCounts = new Array(PALETTE.length).fill(0);
  for (let i = 0; i < guess.length; i++) {
    guessCounts[guess[i]]++;
    codeCounts[code[i]]++;
  }
  let overlap = 0;
  for (let c = 0; c < PALETTE.length; c++) overlap += Math.min(guessCounts[c], codeCounts[c]);

  return { black, white: overlap - black };
}

/** One coloured, lettered peg. `delay` (slot index) staggers the win reveal. */
function Peg({ colour, delay }: { colour: number; delay?: number }) {
  const c = PALETTE[colour];
  return (
    <span className={s.peg} style={sv({ "--bg": c.bg, "--ink": c.ink, "--i": delay ?? 0 })}>
      {c.letter}
    </span>
  );
}

/** Aggregated black/white/empty dots. Blacks first, but that order carries no
 * positional meaning, an unfilled slot fills out the row so counts read at a
 * glance. */
function FeedbackDots({ feedback, length }: { feedback: Feedback; length: number }) {
  const empty = length - feedback.black - feedback.white;
  return (
    <div className={s.feedback} aria-hidden="true">
      {Array.from({ length: feedback.black }, (_, i) => (
        <span key={`b${i}`} className={`${s.dot} ${s.dotBlack}`} />
      ))}
      {Array.from({ length: feedback.white }, (_, i) => (
        <span key={`w${i}`} className={`${s.dot} ${s.dotWhite}`} />
      ))}
      {Array.from({ length: Math.max(0, empty) }, (_, i) => (
        <span key={`e${i}`} className={`${s.dot} ${s.dotEmpty}`} />
      ))}
    </div>
  );
}

export default function Mastermind({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const seed = useSeed(runtime);
  const seedDifficulty = seedString(seed, "difficulty", "normal");
  const initialDifficulty: Difficulty = isDifficulty(seedDifficulty) ? seedDifficulty : "normal";

  const [game, setGame] = useState<Game>(() => newGame("normal"));
  const gameRef = useRef(game);
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<number | null>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const commit = useCallback((next: Game) => {
    gameRef.current = next;
    setGame(next);
  }, []);

  const reset = useCallback(
    (difficulty: Difficulty) => {
      setSelected(null);
      setCursor(0);
      commit(newGame(difficulty));
    },
    [commit],
  );

  // The seed lands after mount (maybe), so apply it the first time it differs
  // from what we booted with. Once applied, further renders leave a player's
  // own Segmented choice alone: the seed value itself never changes again.
  useEffect(() => {
    if (gameRef.current.difficulty !== initialDifficulty) reset(initialDifficulty);
  }, [initialDifficulty, reset]);

  // Keep the newest guess (bottom of the history list, right above the
  // current row) in view without the player having to scroll for it.
  useEffect(() => {
    const el = historyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [game.history.length]);

  const cycleSlot = useCallback(
    (i: number) => {
      const g = gameRef.current;
      if (g.status !== "playing") return;
      const v = g.current[i];
      const next = v === null ? 0 : v + 1 >= g.colours ? null : v + 1;
      const current = [...g.current];
      current[i] = next;
      commit({ ...g, current });
      setCursor(i);
    },
    [commit],
  );

  /** Tap a slot: stamps the selected palette colour if one is picked, else
   * cycles the slot's own colour. Covers touch and mouse with one handler. */
  const placeSelected = useCallback(
    (i: number) => {
      if (selected === null) {
        cycleSlot(i);
        return;
      }
      const g = gameRef.current;
      if (g.status !== "playing") return;
      const current = [...g.current];
      current[i] = selected;
      commit({ ...g, current });
      setCursor(i);
    },
    [selected, cycleSlot, commit],
  );

  const placeDigit = useCallback(
    (colourIndex: number) => {
      const g = gameRef.current;
      if (g.status !== "playing" || colourIndex >= g.colours) return;
      const idx = g.current.indexOf(null);
      if (idx === -1) return;
      const current = [...g.current];
      current[idx] = colourIndex;
      commit({ ...g, current });
      setCursor(idx);
    },
    [commit],
  );

  /** Clears the right-most filled slot, undoing the most recent placement for
   * the common left-to-right fill order (typing, or tapping slots in order). */
  const undoPlacement = useCallback(() => {
    const g = gameRef.current;
    if (g.status !== "playing") return;
    for (let i = g.current.length - 1; i >= 0; i--) {
      if (g.current[i] !== null) {
        const current = [...g.current];
        current[i] = null;
        commit({ ...g, current });
        setCursor(i);
        return;
      }
    }
  }, [commit]);

  const repeatLast = useCallback(() => {
    const g = gameRef.current;
    if (g.status !== "playing" || g.history.length === 0) return;
    commit({ ...g, current: [...g.history[g.history.length - 1].pegs] });
    setCursor(0);
  }, [commit]);

  const submitGuess = useCallback(() => {
    const g = gameRef.current;
    if (g.status !== "playing" || g.current.some((v) => v === null)) return;
    const guess = g.current as number[];
    const code = g.code ?? generateCode(g.length, g.colours, g.repeats);
    const feedback = scoreGuess(guess, code);
    const history = [...g.history, { pegs: guess, feedback }];
    const won = feedback.black === g.length;
    const status: GameStatus = won ? "won" : history.length >= g.maxGuesses ? "over" : "playing";
    commit({ ...g, code, history, current: new Array(g.length).fill(null), status });
    setCursor(0);
  }, [commit]);

  const moveCursor = useCallback((delta: number) => {
    setCursor((c) => clamp(c + delta, 0, gameRef.current.length - 1));
  }, []);

  const digitKeys: Record<string, () => void> = {};
  for (let i = 0; i < game.colours; i++) digitKeys[String(i + 1)] = () => placeDigit(i);
  useKeys({
    ...digitKeys,
    backspace: undoPlacement,
    enter: submitGuess,
    arrowleft: () => moveCursor(-1),
    arrowright: () => moveCursor(1),
  });

  const won = game.status === "won";
  const best = useBest(won ? game.history.length : Infinity, false);

  useGameOverReport(runtime, isTerminal(game.status), () => {
    if (won) {
      return `Mastermind solved in ${game.history.length} of ${game.maxGuesses} guesses on ${game.difficulty} difficulty.`;
    }
    const codeText = game.code ? game.code.map((c) => PALETTE[c].name).join(", ") : "unknown";
    return `Mastermind over on ${game.difficulty} difficulty, out of guesses after ${game.maxGuesses}. The code was ${codeText}.`;
  });

  const [shareStatus, share] = useShare(runtime);
  const tell = useCallback(() => {
    void share(
      won
        ? `I broke the Mastermind code in ${game.history.length} guesses!`
        : `I couldn't break the Mastermind code in ${game.maxGuesses} guesses.`,
      `Mastermind ${game.status}: ${game.history.length}/${game.maxGuesses} guesses on ${game.difficulty}.`,
    );
  }, [share, won, game.history.length, game.maxGuesses, game.status, game.difficulty]);

  const canSubmit = game.status === "playing" && game.current.every((v) => v !== null);
  const canUndo = game.status === "playing" && game.current.some((v) => v !== null);
  const canRepeat = game.status === "playing" && game.history.length > 0;
  const guessNumber = game.status === "playing" ? Math.min(game.history.length + 1, game.maxGuesses) : game.history.length;

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide>
      <GameHeader
        title="Mastermind"
        stats={[
          { label: "Guess", value: `${guessNumber} / ${game.maxGuesses}` },
          { label: "Best", value: best === Infinity ? "–" : best },
        ]}
        hint="Break the hidden colour code from black and white feedback"
      />

      <div className={s.boardWrap}>
        <div className={s.board}>
          <div className={s.history} ref={historyRef}>
            {game.history.map((h, i) => (
              <div
                key={i}
                className={s.row}
                aria-label={`Guess ${i + 1}: ${h.pegs.map((p) => PALETTE[p].name).join(", ")}. Feedback: ${h.feedback.black} exact, ${h.feedback.white} colour matches.`}
              >
                <div className={s.pegRow} aria-hidden="true">
                  {h.pegs.map((p, j) => (
                    <Peg key={j} colour={p} />
                  ))}
                </div>
                <FeedbackDots feedback={h.feedback} length={game.length} />
              </div>
            ))}
          </div>

          <div className={s.currentRow} role="group" aria-label="Current guess">
            <div className={s.pegRow}>
              {game.current.map((v, i) => (
                <button
                  key={i}
                  type="button"
                  className={`${s.slot} ${v !== null ? s.slotFilled : ""} ${i === cursor ? s.slotActive : ""}`}
                  style={v !== null ? sv({ "--bg": PALETTE[v].bg, "--ink": PALETTE[v].ink }) : undefined}
                  onClick={() => placeSelected(i)}
                  disabled={game.status !== "playing"}
                  aria-label={`Slot ${i + 1}${v !== null ? `: ${PALETTE[v].name}` : ", empty"}`}
                >
                  <span aria-hidden="true">{v !== null ? PALETTE[v].letter : ""}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <Overlay
          status={game.status}
          detail={
            won
              ? `Solved in ${game.history.length} guess${game.history.length === 1 ? "" : "es"}.`
              : game.status === "over"
                ? "Out of guesses. Here is the code."
                : undefined
          }
          action={isTerminal(game.status) ? "Play again" : undefined}
          onAction={isTerminal(game.status) ? () => reset(game.difficulty) : undefined}
        >
          {isTerminal(game.status) && game.code && (
            <div
              className={`${s.pegRow} ${won ? s.reveal : ""}`}
              aria-label={`Code: ${game.code.map((c) => PALETTE[c].name).join(", ")}`}
            >
              {game.code.map((c, i) => (
                <Peg key={i} colour={c} delay={won ? i : undefined} />
              ))}
            </div>
          )}
        </Overlay>
      </div>

      <div className={s.palette} role="group" aria-label="Colour palette">
        {PALETTE.slice(0, game.colours).map((c, i) => (
          <button
            key={i}
            type="button"
            className={`${s.swatch} ${selected === i ? s.swatchOn : ""}`}
            style={sv({ "--bg": c.bg, "--ink": c.ink })}
            aria-pressed={selected === i}
            aria-label={c.name}
            disabled={game.status !== "playing"}
            onClick={() => setSelected((sel) => (sel === i ? null : i))}
          >
            {c.letter}
          </button>
        ))}
      </div>

      <ControlBar>
        <button className={`${ui.btn} ${ui.primary}`} onClick={submitGuess} disabled={!canSubmit}>
          Submit
        </button>
        <button className={ui.btn} onClick={repeatLast} disabled={!canRepeat}>
          Repeat last guess
        </button>
        <button className={ui.btn} onClick={undoPlacement} disabled={!canUndo}>
          Undo
        </button>
      </ControlBar>

      <div className={s.difficultyRow}>
        <Segmented label="Difficulty" options={DIFFICULTIES} value={game.difficulty} onChange={reset} />
      </div>

      <StandardControls
        status={game.status}
        onRestart={() => reset(game.difficulty)}
        onShare={tell}
      />

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
