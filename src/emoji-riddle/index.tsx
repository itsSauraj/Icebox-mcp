/**
 * @file Emoji Riddle: decode an emoji string into the film, song or idiom it
 * represents, typed and fuzzy-matched rather than picked from a list.
 *
 * Riddles are resolved the same way Quiz Duel resolves its questions: the
 * model's `riddles` seed may land after mount, so the app opens in a brief
 * "waiting" phase and falls back to a bundled dozen after a short grace
 * period if nothing arrives. A second batch from the model (the "send me
 * more" reply) simply restarts the round with a new deck.
 *
 * Guesses are matched loosely on purpose: typing "lion king" for "The Lion
 * King" should win. `normalize` folds case, accents and punctuation and
 * drops a leading article; `levenshtein` catches typos and minor phrasing
 * drift. The accept radius scales with the answer's length (roughly one edit
 * per five characters), and a miss that lands just outside that radius is
 * called "close" rather than a flat wrong, which is what keeps someone
 * typing a second and third guess instead of giving up.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  StandardControls,
  StatusLine,
  seedArray,
  sv,
  useFullscreen,
  useGameOverReport,
  useSeed,
  useShare,
  type GameStatus,
} from "../lib/game";
import { shuffle } from "../lib/rng";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./riddle.module.css";

const MAX_RIDDLES = 25;
const MAX_WRONG = 5;
const HINT_AT = 3;
/** How long to wait for the model before falling back to the house set. */
const GRACE_MS = 1200;
/** Points for a correct guess, indexed by how many wrong guesses came first. */
const POINTS_BY_ATTEMPTS = [100, 80, 60, 40, 20];

interface Riddle {
  emoji: string;
  answer: string;
  hint?: string;
}

interface Outcome {
  solved: boolean;
  points: number;
}

type Phase = "waiting" | "guessing" | "revealed" | "done";

/**
 * A dozen well-known films and idioms, used whenever the model sends
 * nothing. Kept short and unambiguous so the fallback plays well on its own.
 */
const HOUSE_RIDDLES: Riddle[] = [
  { emoji: "🦁👑🌍", answer: "The Lion King", hint: "Simba grows up to rule the Pride Lands." },
  { emoji: "🕷️🧑🏙️", answer: "Spider-Man", hint: "With great power comes great responsibility." },
  { emoji: "❄️👸⛄", answer: "Frozen", hint: "Let it go." },
  { emoji: "🦈🚤🌊", answer: "Jaws", hint: "You're gonna need a bigger boat." },
  { emoji: "👽🚲🌕", answer: "E.T.", hint: "He just wants to phone home." },
  { emoji: "🚢🧊💔", answer: "Titanic", hint: "Jack and Rose never let go." },
  { emoji: "🍫🏭🎫", answer: "Charlie and the Chocolate Factory", hint: "A golden ticket gets you inside." },
  { emoji: "🐠🔍🌊", answer: "Finding Nemo", hint: "Just keep swimming." },
  { emoji: "🦖🏝️🚪", answer: "Jurassic Park", hint: "Life finds a way." },
  { emoji: "🐱🎒🤫", answer: "let the cat out of the bag", hint: "An idiom about accidentally giving away a secret." },
  { emoji: "🌧️🐱🐶", answer: "it's raining cats and dogs", hint: "An idiom about very heavy rain." },
  { emoji: "🍰🍽️😋", answer: "you can't have your cake and eat it too", hint: "An idiom about not being able to have both." },
];

/**
 * Lowercase, strip diacritics and punctuation, collapse whitespace, and drop
 * a leading article, so "The Lion King!" and "lion king" compare equal.
 */
function normalize(text: string): string {
  const cleaned = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.replace(/^(the|an|a)\s+/, "");
}

/** Iterative edit distance: insert, delete or substitute, one edit each. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

type GuessResult = "correct" | "close" | "wrong";

/**
 * Exact match, or within roughly one edit per five characters, counts as
 * correct. A miss that lands just outside that radius is "close" rather than
 * a flat wrong, so the feedback can encourage another try.
 */
function evaluateGuess(guess: string, answer: string): GuessResult {
  const g = normalize(guess);
  const a = normalize(answer);
  if (!g) return "wrong";
  if (g === a) return "correct";
  const dist = levenshtein(g, a);
  const accept = Math.max(1, Math.round(a.length / 5));
  if (dist <= accept) return "correct";
  if (dist <= accept + 2) return "close";
  return "wrong";
}

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/**
 * Split an emoji string into its individual glyphs, respecting multi-codepoint
 * sequences (ZWJ joins, skin tones, flags) via `Intl.Segmenter` where the
 * runtime supports it, falling back to plain code-point splitting otherwise.
 */
function splitEmoji(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (seg) => seg.segment);
  return Array.from(text);
}

/**
 * Model riddles are already cleaned by games/validate.ts; this is a second,
 * defensive pass for shape only, the same way Quiz Duel re-checks its
 * questions before trusting them.
 */
function readRiddles(raw: unknown[]): Riddle[] {
  const out: Riddle[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const emoji = typeof r.emoji === "string" ? r.emoji.trim() : "";
    const answer = typeof r.answer === "string" ? r.answer.trim() : "";
    if (!emoji || !answer) continue;
    const hint = typeof r.hint === "string" && r.hint.trim() ? r.hint.trim() : undefined;
    out.push({ emoji, answer, ...(hint ? { hint } : {}) });
    if (out.length >= MAX_RIDDLES) break;
  }
  return out;
}

export default function EmojiRiddle({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const seed = useSeed(runtime);
  const [shareStatus, share] = useShare(runtime);

  const sent = useMemo(() => readRiddles(seedArray<unknown>(seed, "riddles")), [seed]);
  const seedSig = sent.length ? JSON.stringify(sent) : "";
  const seedSigRef = useRef("");

  const [deck, setDeck] = useState<Riddle[]>([]);
  const [fromModel, setFromModel] = useState(false);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [index, setIndex] = useState(0);
  const [wrong, setWrong] = useState(0);
  const [outcomes, setOutcomes] = useState<Outcome[]>([]);
  const [guessInput, setGuessInput] = useState("");
  const [lastTry, setLastTry] = useState<"close" | "wrong" | null>(null);
  const [shaking, setShaking] = useState(false);

  const shakeRaf = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextBtnRef = useRef<HTMLButtonElement>(null);

  const begin = useCallback((riddles: Riddle[], model: boolean) => {
    setDeck(riddles);
    setFromModel(model);
    setIndex(0);
    setWrong(0);
    setOutcomes([]);
    setGuessInput("");
    setLastTry(null);
    setPhase(riddles.length ? "guessing" : "waiting");
  }, []);

  // The model's riddles may land after mount. Start the round the moment
  // they arrive, including a later "send me more" reply, which just looks
  // like a second, different batch.
  useEffect(() => {
    if (!seedSig || seedSigRef.current === seedSig) return;
    seedSigRef.current = seedSig;
    begin(sent, true);
  }, [seedSig, sent, begin]);

  // Nothing usable arrived in time: play the bundled set rather than sitting
  // on an empty screen.
  useEffect(() => {
    if (phase !== "waiting") return;
    const id = window.setTimeout(() => begin(HOUSE_RIDDLES, false), GRACE_MS);
    return () => window.clearTimeout(id);
  }, [phase, begin]);

  useEffect(
    () => () => {
      if (shakeRaf.current) cancelAnimationFrame(shakeRaf.current);
    },
    [],
  );

  const triggerShake = useCallback(() => {
    setShaking(false);
    if (shakeRaf.current) cancelAnimationFrame(shakeRaf.current);
    shakeRaf.current = requestAnimationFrame(() => setShaking(true));
  }, []);

  useEffect(() => {
    if (phase === "guessing") inputRef.current?.focus();
  }, [phase, index]);

  useEffect(() => {
    if (phase === "revealed") nextBtnRef.current?.focus();
  }, [phase]);

  const total = deck.length;
  const current: Riddle | undefined = phase === "guessing" || phase === "revealed" ? deck[index] : undefined;
  const currentOutcome: Outcome | undefined = phase === "revealed" ? outcomes[outcomes.length - 1] : undefined;
  const solvedCount = useMemo(() => outcomes.filter((o) => o.solved).length, [outcomes]);
  const score = useMemo(() => outcomes.reduce((sum, o) => sum + o.points, 0), [outcomes]);
  const allDone = phase === "done";
  const status: GameStatus = allDone ? (total > 0 && solvedCount === total ? "won" : "over") : "playing";

  const submitGuess = useCallback(() => {
    if (phase !== "guessing" || !current) return;
    const trimmed = guessInput.trim();
    if (!trimmed) return;
    const result = evaluateGuess(trimmed, current.answer);
    setGuessInput("");
    if (result === "correct") {
      const points = POINTS_BY_ATTEMPTS[Math.min(wrong, POINTS_BY_ATTEMPTS.length - 1)];
      setOutcomes((list) => [...list, { solved: true, points }]);
      setLastTry(null);
      setPhase("revealed");
      return;
    }
    const nextWrong = wrong + 1;
    setWrong(nextWrong);
    triggerShake();
    if (nextWrong >= MAX_WRONG) {
      setOutcomes((list) => [...list, { solved: false, points: 0 }]);
      setLastTry(null);
      setPhase("revealed");
    } else {
      setLastTry(result === "close" ? "close" : "wrong");
    }
  }, [phase, current, guessInput, wrong, triggerShake]);

  const skipRiddle = useCallback(() => {
    if (phase !== "guessing") return;
    setOutcomes((list) => [...list, { solved: false, points: 0 }]);
    setLastTry(null);
    setGuessInput("");
    setPhase("revealed");
  }, [phase]);

  const nextRiddle = useCallback(() => {
    if (phase !== "revealed") return;
    const next = index + 1;
    if (next >= deck.length) {
      setPhase("done");
      return;
    }
    setIndex(next);
    setWrong(0);
    setLastTry(null);
    setPhase("guessing");
  }, [phase, index, deck.length]);

  const replay = useCallback(() => {
    begin(shuffle(deck.length ? deck : HOUSE_RIDDLES), fromModel);
  }, [begin, deck, fromModel]);

  useGameOverReport(runtime, allDone, () =>
    `Emoji Riddle finished: solved ${solvedCount} of ${total}, ${score} points.`,
  );

  const askForMore = useCallback(() => {
    void share(
      "Send me another set of emoji riddles please.",
      `Emoji Riddle finished: solved ${solvedCount} of ${total}, ${score} points.`,
    );
  }, [share, solvedCount, total, score]);

  const verdictMessage = useMemo(() => {
    if (phase === "revealed" && currentOutcome && current) {
      return currentOutcome.solved
        ? `Correct, it's "${current.answer}". Plus ${currentOutcome.points} points.`
        : `Not quite. The answer was "${current.answer}".`;
    }
    if (lastTry === "close") return "So close! Try again.";
    if (lastTry === "wrong") return "Not quite. Try again.";
    return "";
  }, [phase, currentOutcome, current, lastTry]);

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull}>
      <GameHeader
        title="Emoji Riddle"
        icon={
          <span className={s.headerIcon} aria-hidden="true">
            🧩
          </span>
        }
        stats={[
          { label: "Solved", value: solvedCount },
          { label: "Points", value: score },
          { label: "Riddle", value: total ? `${Math.min(index + 1, total)} of ${total}` : "–" },
        ]}
        hint="Decode the emoji into a film, song or idiom."
      />

      <div className={s.boardWrap}>
        {current && (
          <div className={s.stage}>
            <div key={index} className={s.emojiRow} role="img" aria-label="Emoji puzzle to decode">
              {splitEmoji(current.emoji).map((ch, i) => (
                <span key={i} aria-hidden="true" className={s.emojiChar} style={sv({ "--i": i })}>
                  {ch}
                </span>
              ))}
            </div>

            {phase === "guessing" && (
              <form
                className={s.guessForm}
                onSubmit={(e) => {
                  e.preventDefault();
                  submitGuess();
                }}
              >
                <label htmlFor="riddle-guess" className={s.guessLabel}>
                  What does it decode to?
                </label>
                <div
                  className={`${s.inputRow} ${shaking ? s.shake : ""}`}
                  onAnimationEnd={(e) => {
                    if (e.target === e.currentTarget) setShaking(false);
                  }}
                >
                  <input
                    ref={inputRef}
                    id="riddle-guess"
                    className={ui.input}
                    type="text"
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={120}
                    value={guessInput}
                    onChange={(e) => setGuessInput(e.target.value)}
                    placeholder="Type your answer"
                  />
                  <button type="submit" className={`${ui.btn} ${ui.primary}`} disabled={!guessInput.trim()}>
                    Guess
                  </button>
                </div>
              </form>
            )}

            {phase === "guessing" && wrong >= HINT_AT && current?.hint && (
              <p className={s.hintText}>Hint: {current.hint}</p>
            )}

            {phase === "revealed" && currentOutcome && current && (
              <div className={s.reveal}>
                <span className={`${ui.banner} ${currentOutcome.solved ? ui.win : ui.lose}`}>
                  {currentOutcome.solved ? `Correct! +${currentOutcome.points}` : "Not quite"}
                </span>
                <p className={s.answerText}>{current.answer}</p>
                <button ref={nextBtnRef} className={`${ui.btn} ${ui.primary}`} onClick={nextRiddle}>
                  {index + 1 >= total ? "See results" : "Next riddle"}
                </button>
              </div>
            )}
          </div>
        )}

        {phase === "waiting" && <Notice>Loading riddles…</Notice>}

        <Overlay
          status={status}
          detail={`Solved ${solvedCount} of ${total} riddles, ${score} points.`}
          action="Play again"
          onAction={replay}
        />
      </div>

      {phase === "guessing" && (
        <ControlBar>
          <button className={ui.btn} onClick={skipRiddle}>
            Skip
          </button>
        </ControlBar>
      )}

      <StandardControls
        status={status}
        onRestart={replay}
        onShare={askForMore}
        shareLabel="Ask for more"
      />

      <StatusLine>{verdictMessage || shareStatus}</StatusLine>
    </GameFrame>
  );
}
