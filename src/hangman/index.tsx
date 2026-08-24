/**
 * @file Hangman: a run of model-themed words, one classic gallows at a time.
 *
 * The model supplies a topic and a word list through the `play` seed. Since
 * `useSeed` starts empty and fills in after mount, the app opens on a short
 * "waiting" beat and falls back to a built-in word list if nothing usable has
 * arrived by then, the same grace-period pattern Quiz Duel uses. A later seed
 * update (the player asked for a new topic) starts a fresh run the same way,
 * whether or not one is already in progress.
 *
 * The whole run lives in one `Round` object rather than several `useState`
 * calls, so a guess, a solve, a loss and an advance are each a single atomic
 * transition instead of a handful of calls that could disagree with each
 * other. `hintUsedIndex` piggybacks on that object too: comparing it to the
 * current word index is enough to know whether the hint has been spent, and
 * it resets for free the moment the round moves to the next word.
 *
 * The gallows is inline SVG. Every stroke uses `pathLength="1"`, which
 * normalises a circle and a straight limb to the same 0-to-1 range, so one
 * stroke-dasharray trick draws all six parts as wrong guesses land.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  StatusLine,
  seedArray,
  seedString,
  useFullscreen,
  useGameOverReport,
  useKeys,
  useSeed,
  useShare,
  type GameStatus,
} from "../lib/game";
import { shuffle } from "../lib/rng";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./hangman.module.css";

const MAX_WRONG = 6;
/** How long the model gets to deliver words before the fallback set plays. */
const GRACE_MS = 900;
/** How long a solved or lost word stays on screen before advancing. */
const ADVANCE_MS = 1700;
const KEY_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"] as const;

const HOUSE_TOPIC = "Everyday words";
const HOUSE_COUNT = 10;
/** About thirty common English words, used whenever the model sends none. */
const HOUSE_WORDS = [
  "apple", "garden", "bicycle", "mountain", "kitchen", "pillow", "guitar", "rainbow",
  "elephant", "umbrella", "picture", "sandwich", "volcano", "penguin", "library", "blanket",
  "dolphin", "calendar", "chocolate", "backpack", "balloon", "firework", "hospital", "jacket",
  "kangaroo", "lantern", "mailbox", "notebook", "octopus", "pumpkin",
];

/** One gallows stroke as an SVG path, normalised so pathLength="1" applies to all of them. */
const FIGURE_PARTS = [
  "M 96 58 a 14 14 0 1 0 28 0 a 14 14 0 1 0 -28 0", // 1: head
  "M 110 72 L 110 128", // 2: body
  "M 110 88 L 88 110", // 3: left arm
  "M 110 88 L 132 110", // 4: right arm
  "M 110 128 L 88 160", // 5: left leg
  "M 110 128 L 132 160", // 6: right leg
];

interface Round {
  words: string[];
  topic: string;
  fromModel: boolean;
  index: number;
  guessed: Set<string>;
  wrong: number;
  phase: "playing" | "revealed" | "done";
  result: "solved" | "lost" | null;
  solved: number;
  lost: number;
  /** Word index the hint has already been spent on, or -1 if unused this round. */
  hintUsedIndex: number;
}

function begin(words: string[], topic: string, fromModel: boolean): Round {
  return {
    words,
    topic,
    fromModel,
    index: 0,
    guessed: new Set(),
    wrong: 0,
    phase: "playing",
    result: null,
    solved: 0,
    lost: 0,
    hintUsedIndex: -1,
  };
}

/** Letters only, lowercase, deduped and length-capped. The server already
 *  cleans this, but a content game never trusts the model blindly either. */
function sanitizeWords(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const w = item.toLowerCase().replace(/[^a-z]/g, "");
    if (w.length < 2 || w.length > 20 || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= 20) break;
  }
  return out;
}

/** A fresh pick of the house list, so replaying the fallback stays varied. */
const pickHouseWords = () => shuffle(HOUSE_WORDS).slice(0, HOUSE_COUNT);

export default function Hangman({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  const modelWords = useMemo(() => sanitizeWords(seedArray<unknown>(seed, "words")), [seed]);
  const modelTopicRaw = seedString(seed, "topic", "");
  const modelTopic = modelTopicRaw || "Mystery words";

  const [round, setRound] = useState<Round | null>(null);
  const [hintPending, setHintPending] = useState(false);

  // Start (or restart) a run whenever the model sends a genuinely new word
  // list, whether that is the opening seed or a later "new topic" reply.
  const seedSig = modelWords.length ? JSON.stringify([modelTopic, modelWords]) : "";
  const seedSigRef = useRef("");
  useEffect(() => {
    if (!seedSig || seedSigRef.current === seedSig) return;
    seedSigRef.current = seedSig;
    setRound(begin(modelWords, modelTopic, true));
    setHintPending(false);
  }, [seedSig, modelWords, modelTopic]);

  // Nothing arrived in time: play the built-in list rather than show an error.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setRound((cur) => cur ?? begin(pickHouseWords(), HOUSE_TOPIC, false));
    }, GRACE_MS);
    return () => window.clearTimeout(id);
  }, []);

  const currentWord = round ? round.words[round.index] : null;
  const total = round ? round.words.length : 0;
  const isLastWord = round ? round.index + 1 >= total : false;

  const guessLetter = useCallback((ch: string) => {
    setRound((r) => {
      if (!r || r.phase !== "playing") return r;
      if (r.guessed.has(ch)) return r;
      const word = r.words[r.index];
      const guessed = new Set(r.guessed);
      guessed.add(ch);
      if (word.includes(ch)) {
        const solved = word.split("").every((c) => guessed.has(c));
        return solved
          ? { ...r, guessed, phase: "revealed", result: "solved", solved: r.solved + 1 }
          : { ...r, guessed };
      }
      const wrong = r.wrong + 1;
      return wrong >= MAX_WRONG
        ? { ...r, guessed, wrong, phase: "revealed", result: "lost", lost: r.lost + 1 }
        : { ...r, guessed, wrong };
    });
  }, []);

  const advance = useCallback(() => {
    setRound((r) => {
      if (!r || r.phase !== "revealed") return r;
      const next = r.index + 1;
      if (next >= r.words.length) return { ...r, phase: "done" };
      return { ...r, index: next, guessed: new Set(), wrong: 0, phase: "playing", result: null };
    });
  }, []);

  // Auto-advance a beat after a solve or a loss, unless the player taps through first.
  useEffect(() => {
    if (!round || round.phase !== "revealed") return;
    const id = window.setTimeout(advance, ADVANCE_MS);
    return () => window.clearTimeout(id);
  }, [round?.phase, round?.index, advance]);

  const restart = useCallback(() => {
    setRound((r) => {
      if (!r) return r;
      const words = r.fromModel ? shuffle(r.words) : pickHouseWords();
      return begin(words, r.topic, r.fromModel);
    });
    setHintPending(false);
  }, []);

  const askHint = useCallback(async () => {
    const r = round;
    if (!r || r.phase !== "playing" || r.hintUsedIndex === r.index) return;
    const word = r.words[r.index];
    setRound((cur) => (cur ? { ...cur, hintUsedIndex: cur.index } : cur));
    setHintPending(true);
    await share(
      "Give me a one-line hint for the hangman word, without saying the word.",
      `Hangman: topic ${r.topic}, word has ${word.length} letters.`,
    );
    setHintPending(false);
  }, [round, share]);

  const askNewTopic = useCallback(() => {
    if (!round) return;
    void share(
      "Give me a fresh set of hangman words on a different topic.",
      `Hangman finished: solved ${round.solved} of ${round.words.length} on ${round.topic}.`,
    );
  }, [round, share]);

  // a-z guess letters, plus Enter to skip the reveal wait.
  const typing = !!round && round.phase !== "done";
  const keys: Record<string, () => void> = {};
  for (const ch of "abcdefghijklmnopqrstuvwxyz") keys[ch] = () => guessLetter(ch);
  if (round?.phase === "revealed") keys.enter = advance;
  useKeys(keys, typing);

  useGameOverReport(
    runtime,
    round?.phase === "done",
    () =>
      `Hangman finished on ${round?.topic ?? HOUSE_TOPIC}. Solved ${round?.solved ?? 0} of ${round?.words.length ?? 0} words.`,
  );

  const stats =
    !round || round.phase === "done"
      ? round
        ? [{ label: "Solved", value: `${round.solved} of ${round.words.length}` }]
        : undefined
      : [
          { label: "Solved", value: round.solved },
          { label: "Word", value: `${round.index + 1} of ${round.words.length}` },
          { label: "Guesses left", value: MAX_WRONG - round.wrong },
        ];

  const tokens = currentWord
    ? currentWord
        .split("")
        .map((ch) => (round!.guessed.has(ch) || round!.result === "lost" ? ch : null))
    : [];
  const hiddenCount = tokens.filter((t) => t === null).length;
  const wordAriaLabel = currentWord
    ? `${tokens.map((t) => (t ? t.toUpperCase() : "blank")).join(", ")}. ${hiddenCount} letter${hiddenCount === 1 ? "" : "s"} hidden.`
    : "";

  const overlayStatus: GameStatus =
    round?.phase === "revealed" ? (round.result === "solved" ? "won" : "over") : "playing";

  const guessMessage = !round
    ? ""
    : round.phase === "revealed"
      ? round.result === "solved"
        ? "Solved!"
        : `Out of guesses. The word was ${currentWord?.toUpperCase()}.`
      : `${MAX_WRONG - round.wrong} guess${MAX_WRONG - round.wrong === 1 ? "" : "es"} left.`;

  const hintUsed = round ? round.hintUsedIndex === round.index : false;

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide>
      <GameHeader
        title="Hangman"
        icon={
          <span className={s.icon} aria-hidden="true">
            🪢
          </span>
        }
        stats={stats}
        hint={round ? undefined : "Waiting for the model's words"}
      />

      {!round && (
        <div className={s.waiting}>
          <span className={s.dots} aria-hidden="true">
            <i className={s.dot} />
            <i className={s.dot} />
            <i className={s.dot} />
          </span>
          <p className={s.waitText}>Setting up the word list.</p>
        </div>
      )}

      {round && round.phase !== "done" && currentWord && (
        <>
          <p className={s.topic}>{round.topic}</p>

          <div className={s.boardWrap}>
            <svg
              className={s.gallows}
              viewBox="0 0 160 200"
              role="img"
              aria-label={`Hangman figure, ${round.wrong} of ${MAX_WRONG} wrong guesses`}
            >
              <g aria-hidden="true">
                <path className={s.gallowsPost} d="M 10 190 L 90 190" />
                <path className={s.gallowsPost} d="M 30 190 L 30 20" />
                <path className={s.gallowsPost} d="M 30 20 L 112 20" />
                <path className={s.gallowsPost} d="M 30 46 L 54 20" />
                <path className={s.gallowsPost} d="M 110 20 L 110 34" />
              </g>
              <g aria-hidden="true">
                {FIGURE_PARTS.map((d, i) => (
                  <path
                    key={i}
                    d={d}
                    pathLength={1}
                    className={`${s.part} ${round.wrong >= i + 1 ? s.partOn : ""}`}
                  />
                ))}
              </g>
            </svg>

            <div className={s.wordRow} role="img" aria-label={wordAriaLabel}>
              {tokens.map((t, i) => (
                <span key={`${i}-${t ? "r" : "h"}`} className={`${s.tile} ${t ? s.filled : ""}`}>
                  {t ? t.toUpperCase() : ""}
                </span>
              ))}
            </div>

            <p className={s.guessStatus} role="status" aria-live="polite">
              {guessMessage}
            </p>

            <Overlay
              status={overlayStatus}
              title={round.result === "solved" ? "Solved!" : "Word lost"}
              detail={
                round.result === "lost"
                  ? `The word was ${currentWord.toUpperCase()}.`
                  : "Nice guessing."
              }
              action={isLastWord ? "See results" : "Next word"}
              onAction={advance}
            />
          </div>

          <div className={s.keyboard} role="group" aria-label="Keyboard">
            {KEY_ROWS.map((row, ri) => (
              <div className={s.krow} key={ri}>
                {row.split("").map((ch) => {
                  const lower = ch.toLowerCase();
                  const used = round.guessed.has(lower);
                  const state = !used ? "" : currentWord.includes(lower) ? s.correct : s.wrong;
                  return (
                    <button
                      key={ch}
                      className={`${s.key} ${state}`}
                      onClick={() => guessLetter(lower)}
                      disabled={used || round.phase !== "playing"}
                      aria-label={ch}
                    >
                      {ch}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className={s.hintRow}>
            <button
              className={`${ui.btn} ${ui.primary}`}
              onClick={askHint}
              disabled={round.phase !== "playing" || hintUsed || hintPending}
            >
              {hintPending ? "Asking..." : hintUsed ? "Hint asked" : "Ask for a hint"}
            </button>
          </div>

          <ControlBar>
            <button className={ui.btn} onClick={restart}>
              Restart
            </button>
            <button className={ui.btn} onClick={toggleFull}>
              {isFull ? "Exit fullscreen" : "Fullscreen"}
            </button>
          </ControlBar>

          <p className={s.hintLine}>Type a letter to guess it, or use the keyboard above.</p>

          {!round.fromModel && (
            <Notice>No topic came through, so this is the built-in word list.</Notice>
          )}
        </>
      )}

      {round && round.phase === "done" && (
        <div className={s.results}>
          <p className={s.resultBig}>
            {round.solved} / {round.words.length}
          </p>
          <p className={s.resultLabel}>solved on {round.topic}</p>
          <div className={s.actions}>
            <button className={`${ui.btn} ${ui.primary}`} onClick={askNewTopic}>
              New topic
            </button>
            <button className={ui.btn} onClick={restart}>
              Play again
            </button>
            <button className={ui.btn} onClick={toggleFull}>
              {isFull ? "Exit fullscreen" : "Fullscreen"}
            </button>
          </div>
        </div>
      )}

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
