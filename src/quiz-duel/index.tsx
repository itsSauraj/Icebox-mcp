/**
 * @file Quiz Duel: timed trivia on whatever the model can write questions for.
 *
 * The model owns the content, the app owns the game show. A seed carries a
 * topic, a list of questions with a correct index, and a per-question time
 * limit; everything else (pacing, scoring, lifelines, review) is local, so a
 * whole round costs exactly zero model turns after the first one.
 *
 * Three things are worth explaining.
 *
 * **The seed lands late.** `useSeed` fills in after mount, so the app opens on
 * a waiting state. A signature ref starts a fresh round the moment questions
 * arrive, which also handles the "ten more questions" button: that reply comes
 * back as a new seed and simply becomes the next round. If nothing arrives
 * within a beat, `HOUSE_QUESTIONS` takes over, because a trivia game that shows
 * an error instead of a question has failed at its one job.
 *
 * **Resolution is idempotent.** A question can end three ways (tapped, timed
 * out, skipped) and two of them can race. `resolvedRef` holds the index of the
 * last question already scored, so a tap landing in the same frame as the
 * expiry, or a StrictMode double-invoked effect, cannot score twice. All the
 * callbacks read mutable state through refs, which keeps them stable enough to
 * sit in the auto-advance effect without restarting its timer.
 *
 * **Scoring rewards nerve.** A correct answer is worth 100 scaled by the
 * fraction of the clock left, times the streak, capped at 5x. Answering fast on
 * a hot streak is worth roughly ten times a slow answer from cold, which is the
 * whole tension of the format.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GameFrame,
  GameHeader,
  Notice,
  StatusLine,
  seedArray,
  seedNumber,
  seedString,
  sv,
  useCountdown,
  useFullscreen,
  useGameOverReport,
  useKeys,
  useSeed,
  useShare,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import { shuffle } from "../lib/rng";
import ui from "../lib/ui.module.css";
import s from "./quiz.module.css";

const MAX_QUESTIONS = 25;
const BASE_POINTS = 100;
const MAX_MULTIPLIER = 5;
const EXTRA_SECONDS = 10;
/** How long the verdict stays up before the next question, unless tapped. */
const REVEAL_MS = 1500;
/** How long to wait for the model before falling back to the built-in set. */
const GRACE_MS = 1200;
const LETTERS = "ABCDEF";

/** Sentinels for the two ways a question ends without a tap. */
const TIMED_OUT = -1;
const SKIPPED = -2;

interface Question {
  question: string;
  options: string[];
  answer: number;
  note?: string;
}

/** One resolved question. `lost` is the streak a wrong answer threw away. */
interface Answer {
  chosen: number;
  gained: number;
  multiplier: number;
  lost: number;
}

type Phase = "waiting" | "asking" | "revealed" | "done";

interface Lifelines {
  fifty: boolean;
  skip: boolean;
  time: boolean;
}

const FRESH: Lifelines = { fifty: false, skip: false, time: false };

/**
 * The built-in round. Ten questions of plain general knowledge, deliberately
 * short so they read well at the large question size, and answerable by anyone.
 */
const HOUSE_QUESTIONS: Question[] = [
  { question: "Which planet orbits closest to the Sun?", options: ["Venus", "Mercury", "Mars", "Earth"],
    answer: 1, note: "Mercury sits about 58 million km out." },
  { question: "What is the largest ocean on Earth?", options: ["Atlantic", "Indian", "Pacific", "Arctic"],
    answer: 2, note: "The Pacific covers roughly a third of the planet." },
  { question: "Who painted the Mona Lisa?", options: ["Michelangelo", "Raphael", "Donatello", "Leonardo da Vinci"],
    answer: 3 },
  { question: "What is the chemical symbol for gold?", options: ["Go", "Gd", "Au", "Ag"],
    answer: 2, note: "From aurum, the Latin for gold." },
  { question: "How many minutes are in a full day?", options: ["720", "1000", "1440", "2400"],
    answer: 2, note: "24 hours times 60." },
  { question: "Which city hosted the first modern Olympic Games?", options: ["Paris", "Athens", "London", "Rome"],
    answer: 1, note: "Athens, in 1896." },
  { question: "What is the tallest land animal?", options: ["African elephant", "Giraffe", "Moose", "Camel"],
    answer: 1 },
  { question: "How many strings does a standard guitar have?", options: ["4", "5", "6", "7"],
    answer: 2 },
  { question: "Which language has the most native speakers?", options: ["English", "Spanish", "Hindi", "Mandarin Chinese"],
    answer: 3, note: "Roughly a billion first-language speakers." },
  { question: "What does a barometer measure?", options: ["Humidity", "Air pressure", "Wind speed", "Rainfall"],
    answer: 1, note: "Falling pressure usually means weather is on the way." },
];

/**
 * Read the seed's questions. The server has already validated these, so this is
 * a second pass for shape only: it drops anything with too few options or an
 * answer index out of range rather than trusting the index blindly.
 */
function readQuestions(raw: unknown[]): Question[] {
  const out: Question[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const question = typeof r.question === "string" ? r.question.trim() : "";
    const options = Array.isArray(r.options)
      ? r.options.filter((o): o is string => typeof o === "string" && o.trim() !== "").map((o) => o.trim())
      : [];
    const answer = typeof r.answer === "number" ? Math.trunc(r.answer) : -1;
    if (!question || options.length < 2 || options.length > LETTERS.length) continue;
    if (answer < 0 || answer >= options.length) continue;
    const note = typeof r.note === "string" && r.note.trim() ? r.note.trim() : undefined;
    out.push({ question, options, answer, ...(note ? { note } : {}) });
    if (out.length >= MAX_QUESTIONS) break;
  }
  return out;
}

/** Points for a correct answer: base, scaled by clock left, times the streak. */
function award(left: number, seconds: number, multiplier: number): number {
  const speed = seconds > 0 ? Math.max(0, Math.min(1, left / seconds)) : 0;
  return Math.round(BASE_POINTS * (0.5 + 0.5 * speed)) * multiplier;
}

/** Timer band. Only three states, so the colour shift reads as a warning. */
const band = (left: number, seconds: number) => {
  const frac = seconds > 0 ? left / seconds : 1;
  if (left <= 3) return s.crit;
  if (frac <= 0.4) return s.warn;
  return s.calm;
};

/** Threshold words for the live region. Changes three times, not every second. */
const timeWord = (left: number) => {
  if (left <= 3) return "3 seconds left";
  if (left <= 5) return "5 seconds left";
  if (left <= 10) return "10 seconds left";
  return "";
};

/**
 * Draining bar plus the seconds left. The fill CSS-transitions its own width
 * once a second, and `nth` remounts it per question so a fresh clock snaps to
 * full instead of animating a refill.
 */
function Timer({ left, seconds, nth }: { left: number; seconds: number; nth: number }) {
  const pct = seconds > 0 ? Math.min(100, (left / seconds) * 100) : 0;
  return (
    <div className={`${s.timerRow} ${band(left, seconds)}`} aria-hidden="true">
      <div className={s.timerTrack}>
        <span key={nth} className={s.timerFill} style={sv({ "--pct": `${pct}%` })} />
      </div>
      <b className={s.timerNum}>{left}s</b>
    </div>
  );
}

/** Every question with what you said and what was right, scrollable. */
function Review({ deck, answers }: { deck: Question[]; answers: Answer[] }) {
  return (
    <div className={s.review} tabIndex={0} role="group" aria-label="Question review">
      {deck.map((q, i) => {
        const a = answers[i];
        const hit = a && a.chosen === q.answer;
        const skipped = a && a.chosen === SKIPPED;
        const yours =
          !a || a.chosen === TIMED_OUT ? "ran out of time" : skipped ? "skipped" : q.options[a.chosen];
        return (
          <article key={i} className={s.revItem}>
            <span
              className={`${s.revMark} ${hit ? s.markRight : skipped ? s.markSkip : s.markWrong}`}
              aria-hidden="true"
            >
              {hit ? "✓" : skipped ? "»" : "✕"}
            </span>
            <div className={s.revBody}>
              <p className={s.revQ}>{q.question}</p>
              <p className={s.revAns}>
                <b>{q.options[q.answer]}</b>
                {hit ? ` · +${a.gained}` : ` · you said ${yours}`}
              </p>
              {q.note && <p className={s.revNote}>{q.note}</p>}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export default function QuizDuel({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  const topic = seedString(seed, "topic", "General knowledge");
  const seconds = seedNumber(seed, "seconds", 15, 5, 60);
  const sent = useMemo(() => readQuestions(seedArray<unknown>(seed, "questions")), [seed]);

  const [deck, setDeck] = useState<Question[]>([]);
  const [fromModel, setFromModel] = useState(false);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("waiting");
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [longest, setLongest] = useState(0);
  const [hidden, setHidden] = useState<number[]>([]);
  const [spent, setSpent] = useState<Lifelines>(FRESH);

  const [left, resetTimer] = useCountdown(seconds, phase === "asking");

  // Mirrors so the resolve and advance callbacks can stay identity-stable and
  // sit safely in effects. Written in one effect, after every render.
  const phaseRef = useRef<Phase>("waiting");
  const indexRef = useRef(0);
  const deckRef = useRef<Question[]>([]);
  const streakRef = useRef(0);
  const leftRef = useRef(seconds);
  const secondsRef = useRef(seconds);
  const resetRef = useRef(resetTimer);
  /** Index of the last question already scored, so nothing scores twice. */
  const resolvedRef = useRef(-1);
  const seedSigRef = useRef("");

  useEffect(() => {
    phaseRef.current = phase;
    indexRef.current = index;
    deckRef.current = deck;
    streakRef.current = streak;
    leftRef.current = left;
    secondsRef.current = seconds;
    resetRef.current = resetTimer;
  });

  const total = deck.length;
  const current: Question | undefined = deck[index];
  const outcome: Answer | undefined = phase === "revealed" ? answers[index] : undefined;
  const correctCount = useMemo(
    () => answers.filter((a, i) => a.chosen === deck[i]?.answer).length,
    [answers, deck],
  );

  /** Begin a round. Refs are written first so a resolve in the same tick agrees. */
  const begin = useCallback(
    (questions: Question[], model: boolean) => {
      phaseRef.current = "asking";
      indexRef.current = 0;
      deckRef.current = questions;
      streakRef.current = 0;
      resolvedRef.current = -1;
      setDeck(questions);
      setFromModel(model);
      setIndex(0);
      setAnswers([]);
      setScore(0);
      setStreak(0);
      setLongest(0);
      setHidden([]);
      setSpent(FRESH);
      setPhase("asking");
      resetRef.current(secondsRef.current);
    },
    [],
  );

  // Questions from the model start a round, including a second batch arriving
  // later. The signature covers everything that would change the round, so a
  // host resending an identical notification is ignored.
  const seedSig = sent.length ? JSON.stringify([topic, seconds, sent]) : "";
  useEffect(() => {
    if (!seedSig || seedSigRef.current === seedSig) return;
    seedSigRef.current = seedSig;
    begin(sent, true);
  }, [seedSig, sent, begin]);

  // Nothing usable arrived, so play our own set rather than showing an error.
  useEffect(() => {
    if (phase !== "waiting") return;
    const id = window.setTimeout(() => {
      if (phaseRef.current === "waiting") begin(HOUSE_QUESTIONS, false);
    }, GRACE_MS);
    return () => window.clearTimeout(id);
  }, [phase, begin]);

  /** Score the current question and show the verdict. Safe to call twice. */
  const resolve = useCallback((chosen: number) => {
    const i = indexRef.current;
    const q = deckRef.current[i];
    if (!q || phaseRef.current !== "asking" || resolvedRef.current === i) return;
    resolvedRef.current = i;
    phaseRef.current = "revealed";

    const hit = chosen === q.answer;
    const run = streakRef.current;
    const multiplier = hit ? Math.min(MAX_MULTIPLIER, run + 1) : 0;
    const gained = hit ? award(leftRef.current, secondsRef.current, multiplier) : 0;
    // A skip is free: it costs the question but not the streak.
    const lost = hit || chosen === SKIPPED ? 0 : run;

    if (hit) {
      streakRef.current = run + 1;
      setScore((v) => v + gained);
      setStreak(run + 1);
      setLongest((v) => Math.max(v, run + 1));
    } else if (chosen !== SKIPPED) {
      streakRef.current = 0;
      setStreak(0);
    }
    setAnswers((list) => [...list, { chosen, gained, multiplier, lost }]);
    setPhase("revealed");
  }, []);

  /** Move to the next question, or finish the round. */
  const advance = useCallback(() => {
    if (phaseRef.current !== "revealed") return;
    const next = indexRef.current + 1;
    if (next >= deckRef.current.length) {
      phaseRef.current = "done";
      setPhase("done");
      return;
    }
    phaseRef.current = "asking";
    indexRef.current = next;
    setIndex(next);
    setHidden([]);
    setPhase("asking");
    resetRef.current(secondsRef.current);
  }, []);

  // Running out of time counts as wrong. Handled here rather than through the
  // countdown's own callback so it cannot fire mid-render.
  useEffect(() => {
    if (phase === "asking" && left <= 0) resolve(TIMED_OUT);
  }, [phase, left, resolve]);

  // Auto-advance after the verdict. Keyed on the index too, so each question
  // gets its own timer.
  useEffect(() => {
    if (phase !== "revealed") return;
    const id = window.setTimeout(advance, REVEAL_MS);
    return () => window.clearTimeout(id);
  }, [phase, index, advance]);

  const asking = phase === "asking";

  /** 50/50: strike out half the wrong options, never the right one. */
  const playFifty = () => {
    if (!asking || spent.fifty || !current || current.options.length < 3) return;
    const wrong = current.options.map((_, i) => i).filter((i) => i !== current.answer);
    setHidden(shuffle(wrong).slice(0, Math.ceil(wrong.length / 2)));
    setSpent((l) => ({ ...l, fifty: true }));
  };

  /** Skip: costs the question, but not the streak. */
  const playSkip = () => {
    if (!asking || spent.skip) return;
    setSpent((l) => ({ ...l, skip: true }));
    resolve(SKIPPED);
  };

  const playExtraTime = () => {
    if (!asking || spent.time) return;
    setSpent((l) => ({ ...l, time: true }));
    resetTimer(left + EXTRA_SECONDS);
  };

  const replay = () => begin(shuffle(deck), fromModel);

  const askForMore = () =>
    void share(
      `Ten more questions on ${topic} please.`,
      `Quiz Duel finished: ${score} points, ${correctCount} of ${total} correct on ${topic}.`,
    );

  // Digits pick an option, F/S/T spend a lifeline, Enter skips the verdict.
  const keys: Record<string, () => void> = {};
  if (asking && current) {
    current.options.forEach((_, i) => {
      if (!hidden.includes(i)) keys[String(i + 1)] = () => resolve(i);
    });
    if (!spent.fifty && current.options.length >= 3) keys.f = playFifty;
    if (!spent.skip) keys.s = playSkip;
    if (!spent.time) keys.t = playExtraTime;
  }
  if (phase === "revealed") keys.enter = advance;
  useKeys(keys);

  useGameOverReport(
    runtime,
    phase === "done",
    () =>
      `Quiz Duel finished on ${topic}. Score ${score}, ${correctCount} of ${total} correct, longest streak ${longest}.`,
  );

  const multiplier = Math.min(MAX_MULTIPLIER, streak + 1);

  let verdict = "";
  if (outcome && current) {
    const right = `${LETTERS[current.answer]}, ${current.options[current.answer]}`;
    if (outcome.chosen === current.answer) {
      verdict = `Correct${outcome.multiplier > 1 ? `, ${outcome.multiplier}x streak` : ""}`;
    } else if (outcome.chosen === TIMED_OUT) {
      verdict = `Time up. The answer was ${right}`;
    } else if (outcome.chosen === SKIPPED) {
      verdict = `Skipped. The answer was ${right}`;
    } else {
      verdict = `Wrong. The answer was ${right}`;
    }
  }

  // Four short answers read as a game-show quadrant. Longer ones stack, so a
  // sentence-length option never gets squeezed into half a column.
  const quadrant =
    !!current && current.options.length === 4 && current.options.every((o) => o.length <= 16);

  const tally: [string, string | number][] = [
    ["Correct", `${correctCount}/${total}`],
    ["Best streak", longest],
    ["Lifelines used", `${Object.values(spent).filter(Boolean).length}/3`],
  ];

  const stats =
    phase === "done"
      ? [
          { label: "Score", value: score },
          { label: "Correct", value: `${correctCount} of ${total}` },
          { label: "Best streak", value: longest },
        ]
      : [
          { label: "Score", value: score },
          { label: "Streak", value: streak },
          { label: "Question", value: total ? `${index + 1} of ${total}` : "-" },
        ];

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide>
      <GameHeader
        title="Quiz Duel"
        icon={
          <span className={s.icon} aria-hidden="true">
            🎯
          </span>
        }
        stats={phase === "waiting" ? undefined : stats}
        hint={phase === "waiting" ? "Timed trivia, written for you" : undefined}
      />

      {phase === "done" ? (
        <div className={s.results}>
          <div>
            <p className={s.scoreBig}>{score}</p>
            <p className={s.scoreLabel}>points on {topic}</p>
          </div>

          <div className={s.tally}>
            {tally.map(([label, value]) => (
              <div key={label} className={s.tallyCell}>
                <b className={s.tallyNum}>{value}</b>
                <span className={s.tallyLabel}>{label}</span>
              </div>
            ))}
          </div>

          <p className={s.reviewLabel}>Every question</p>
          <Review deck={deck} answers={answers} />

          <div className={s.actions}>
            <button className={`${ui.btn} ${ui.primary}`} onClick={askForMore}>
              Ten more questions
            </button>
            <button className={ui.btn} onClick={replay}>
              Play again
            </button>
            <button className={ui.btn} onClick={toggleFull}>
              {isFull ? "Exit fullscreen" : "Fullscreen"}
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className={s.topic}>{topic}</p>

          {total > 0 && (
            <div className={s.pips} aria-hidden="true">
              {deck.map((q, i) => {
                const a = answers[i];
                const cls = !a
                  ? i === index
                    ? s.pipNow
                    : ""
                  : a.chosen === q.answer
                    ? s.pipRight
                    : a.chosen === SKIPPED
                      ? s.pipSkip
                      : s.pipWrong;
                return <span key={i} className={`${s.pip} ${cls}`} />;
              })}
            </div>
          )}

          <div className={s.stage}>
            {!current ? (
              <div className={s.waiting}>
                <span className={s.dots} aria-hidden="true">
                  <i className={s.dot} />
                  <i className={s.dot} />
                  <i className={s.dot} />
                </span>
                <p className={s.waitText}>Waiting on the questions.</p>
              </div>
            ) : (
              <>
                <Timer left={left} seconds={seconds} nth={index} />

                <div className={s.qMeta}>
                  <span>
                    Question {index + 1} of {total}
                  </span>
                  {asking && streak > 0 && <span>{multiplier}x on the line</span>}
                </div>
                <p key={index} className={s.qText}>
                  {current.question}
                </p>

                <div
                  className={`${s.options} ${quadrant ? s.two : ""}`}
                  role="group"
                  aria-label="Answers"
                >
                  {current.options.map((opt, i) => {
                    const struck = hidden.includes(i);
                    const isAnswer = i === current.answer;
                    const picked = outcome?.chosen === i;
                    const cls = outcome
                      ? isAnswer
                        ? s.right
                        : picked
                          ? s.wrong
                          : s.faded
                      : struck
                        ? s.removed
                        : "";
                    return (
                      <button
                        key={i}
                        className={`${s.opt} ${cls}`}
                        onClick={() => resolve(i)}
                        disabled={!asking || struck}
                      >
                        <span className={s.optKey} aria-hidden="true">
                          {LETTERS[i]}
                        </span>
                        <span className={s.optText}>{opt}</span>
                      </button>
                    );
                  })}
                </div>

                <div role="status" aria-live="polite">
                  <p className={s.verdict}>
                    {outcome ? (
                      <>
                        <span
                          className={`${s.tag} ${
                            outcome.chosen === current.answer
                              ? s.tagRight
                              : outcome.chosen === SKIPPED
                                ? s.tagFlat
                                : s.tagWrong
                          }`}
                        >
                          {verdict}
                        </span>
                        {outcome.gained > 0 && (
                          <span key={index} className={s.gain}>
                            +{outcome.gained}
                          </span>
                        )}
                      </>
                    ) : (
                      timeWord(left) && (
                        <span className={`${s.tag} ${s.tagFlat}`}>{timeWord(left)}</span>
                      )
                    )}
                  </p>
                  {outcome && current.note && <p className={s.note}>{current.note}</p>}
                </div>

                <div className={s.streakRow}>
                  <span
                    key={`${index}-${outcome ? "r" : "a"}`}
                    className={`${s.streak} ${
                      outcome && outcome.lost >= 2
                        ? s.broke
                        : streak >= 3
                          ? s.streakHot
                          : streak > 0
                            ? s.streakOn
                            : ""
                    }`}
                  >
                    {outcome && outcome.lost >= 1
                      ? `Streak of ${outcome.lost} broken`
                      : streak > 0
                        ? `🔥 ${streak} in a row`
                        : "No streak yet"}
                    {streak > 0 && !outcome && <span className={s.mult}>{multiplier}x</span>}
                  </span>

                  <div className={s.lifelines} role="group" aria-label="Lifelines">
                    <button
                      className={`${s.lifeline} ${spent.fifty ? s.spent : ""}`}
                      onClick={playFifty}
                      disabled={!asking || spent.fifty || current.options.length < 3}
                      aria-label={spent.fifty ? "50/50, already used" : "50/50, strike out wrong answers"}
                    >
                      50/50
                    </button>
                    <button
                      className={`${s.lifeline} ${spent.skip ? s.spent : ""}`}
                      onClick={playSkip}
                      disabled={!asking || spent.skip}
                      aria-label={spent.skip ? "Skip, already used" : "Skip this question"}
                    >
                      Skip
                    </button>
                    <button
                      className={`${s.lifeline} ${spent.time ? s.spent : ""}`}
                      onClick={playExtraTime}
                      disabled={!asking || spent.time}
                      aria-label={
                        spent.time ? "Extra time, already used" : `Add ${EXTRA_SECONDS} seconds`
                      }
                    >
                      +{EXTRA_SECONDS}s
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {current && (
            <div className={s.nextRow}>
              <button
                className={`${ui.btn} ${ui.primary}`}
                onClick={advance}
                disabled={phase !== "revealed"}
              >
                {index + 1 >= total ? "See results" : "Next question"}
              </button>
              <button className={ui.btn} onClick={replay}>
                Restart
              </button>
              <button className={ui.btn} onClick={toggleFull}>
                {isFull ? "Exit fullscreen" : "Fullscreen"}
              </button>
            </div>
          )}

          {current && (
            <p className={s.hintLine}>
              Press 1 to {current.options.length} to answer. F for 50/50, S to skip, T for more
              time.
            </p>
          )}

          {current && !fromModel && (
            <Notice>No questions came through, so this is the built-in set.</Notice>
          )}
        </>
      )}

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
