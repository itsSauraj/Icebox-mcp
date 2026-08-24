/**
 * @file 20 Questions: the model asks, the player answers yes or no.
 *
 * There is no dedicated schema for this game. The `play` tool has one shared
 * free text field, `topic`, and the model is told to reuse it to carry the
 * current question, one at a time. So the whole turn loop is: read `topic`
 * out of the seed, show it, and report the player's tap back through
 * `share`, which costs one model turn and comes back as the next `topic`.
 *
 * The app keeps score, not the model. Nothing in the seed says "this is
 * question 7" or "the round just ended", so a new `topic` arriving is simply
 * read as "the next question", counted locally, and the previous question's
 * answer is filed into the transcript at that point: the same
 * commit-on-arrival pattern `src/story-quest/index.tsx` uses for its beats,
 * guarded by a signature so a resent identical notification is a no-op.
 *
 * The model has no field to say "I got it" either, so the round ends from
 * the player's side: "That's it!" credits the current line as a correct
 * guess, "Give up" ends things early in the player's favour and invites the
 * model to reveal its guess out loud. Running out of the 20 questions ends
 * the round the same way, automatically, the moment the last answer lands.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  StatusLine,
  seedString,
  sv,
  useFullscreen,
  useGameOverReport,
  useKeys,
  useSeed,
  useShare,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./twenty.module.css";

const MAX_QUESTIONS = 20;
const ENDGAME_AT = 16;

type Answer = "Yes" | "No" | "Sometimes";
type EndResult = "guessed" | "gaveUp" | "ranOut";

/** One logged question and how it was resolved. */
interface QA {
  n: number;
  q: string;
  a: string;
  /** The line that closed the round, styled apart from a plain answer. */
  final?: boolean;
}

interface EndState {
  result: EndResult;
  questions: number;
}

const plural = (n: number) => (n === 1 ? "question" : "questions");

function endTitle(e: EndState): string {
  if (e.result === "guessed") return `Got it in ${e.questions}`;
  if (e.result === "gaveUp") return "You gave up";
  return "Ran out of questions";
}

function endDetail(e: EndState): string {
  if (e.result === "guessed") return `The model guessed correctly after ${e.questions} ${plural(e.questions)}.`;
  if (e.result === "gaveUp") return `You ended the round after ${e.questions} ${plural(e.questions)}. Time to tell the model what it was.`;
  return `All ${MAX_QUESTIONS} questions used without a correct guess.`;
}

/** Transcript entry, rendered inside the scrollable list. */
function QaRow({ item }: { item: QA }) {
  return (
    <li className={`${s.qa} ${item.final ? s.qaFinal : ""}`}>
      <span className={s.qaN} aria-hidden="true">
        {item.n}.
      </span>
      <span className={s.qaBody}>
        <span className={s.qaQ}>{item.q}</span>
        <span className={s.qaA}>{item.a}</span>
      </span>
    </li>
  );
}

export default function TwentyQuestions({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);
  const topic = seedString(seed, "topic").trim();

  const [count, setCount] = useState(0);
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<QA[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [end, setEnd] = useState<EndState | null>(null);

  // Mirrors of the committed state for the effect and the click handlers, so
  // they read the latest without listing fast-changing state as a dependency
  // and re-running (or going stale) on their own writes.
  const countRef = useRef(0);
  const questionRef = useRef("");
  const historyRef = useRef<QA[]>([]);
  const pendingRef = useRef<string | null>(null);
  const restartRef = useRef(false);
  const sigRef = useRef("");
  const listRef = useRef<HTMLUListElement>(null);

  const waiting = pending !== null;

  const pushHistory = useCallback((entry: QA) => {
    const next = [...historyRef.current, entry];
    historyRef.current = next;
    setHistory(next);
  }, []);

  /**
   * Commit an arriving question. A restart ("I'm thinking of something" or
   * "Play again") clears the board even if the incoming text happens to
   * match whatever was last committed; otherwise an unchanged signature is a
   * resent notification and is ignored.
   */
  useEffect(() => {
    if (!topic || sigRef.current === topic) return;
    sigRef.current = topic;

    const restarting = restartRef.current;
    restartRef.current = false;

    const prevQuestion = questionRef.current;
    const prevCount = countRef.current;
    const prevAnswer = pendingRef.current;

    if (restarting) {
      historyRef.current = [];
      setHistory([]);
      setEnd(null);
    } else if (prevQuestion && prevAnswer) {
      // The previous question's answer only lands in the transcript once the
      // next one arrives, so the two questions never race for the same slot.
      pushHistory({ n: prevCount, q: prevQuestion, a: prevAnswer });
    }

    const nextCount = restarting ? 1 : Math.min(prevCount + 1, MAX_QUESTIONS);
    countRef.current = nextCount;
    questionRef.current = topic;
    pendingRef.current = null;

    setCount(nextCount);
    setQuestion(topic);
    setPending(null);
  }, [topic, pushHistory]);

  // Keep the transcript scrolled to its newest entry.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length]);

  /** Ask the model to start a fresh round, from either the empty state or the end panel. */
  const restart = useCallback(
    (message: string) => {
      if (pendingRef.current !== null) return;
      pendingRef.current = "";
      setPending("");
      restartRef.current = true;
      void share(message);
    },
    [share],
  );

  const answer = useCallback(
    (label: Answer) => {
      if (end || pendingRef.current !== null || !questionRef.current) return;
      const n = countRef.current;
      if (n >= MAX_QUESTIONS) {
        // No 21st question is coming: the round ends right here.
        pushHistory({ n, q: questionRef.current, a: label, final: true });
        setEnd({ result: "ranOut", questions: n });
        void share(
          `${label}.`,
          `20 Questions: question ${n} of ${MAX_QUESTIONS}, answered ${label.toLowerCase()}. That was the last question, no correct guess yet.`,
        );
        return;
      }
      pendingRef.current = label;
      setPending(label);
      void share(`${label}.`, `20 Questions: that was question ${n}, answered ${label.toLowerCase()}.`);
    },
    [end, share, pushHistory],
  );

  const gotIt = useCallback(() => {
    if (end || !questionRef.current) return;
    const n = countRef.current;
    pushHistory({ n, q: questionRef.current, a: "Got it!", final: true });
    pendingRef.current = null;
    setPending(null);
    setEnd({ result: "guessed", questions: n });
    void share("That's it, you got it!", `20 Questions: the model guessed correctly after ${n} ${plural(n)}.`);
  }, [end, share, pushHistory]);

  const giveUp = useCallback(() => {
    if (end || countRef.current === 0) return;
    const n = countRef.current;
    const q = questionRef.current;
    const a = pendingRef.current;
    if (q && a) pushHistory({ n, q, a });
    pendingRef.current = null;
    setPending(null);
    setEnd({ result: "gaveUp", questions: n });
    void share("I give up, what's your guess?", `20 Questions: the player gave up after ${n} ${plural(n)}. Reveal your best guess.`);
  }, [end, share, pushHistory]);

  useKeys({
    y: () => answer("Yes"),
    n: () => answer("No"),
    s: () => answer("Sometimes"),
  });

  useGameOverReport(runtime, end !== null, () => {
    const answered = historyRef.current.length;
    if (!end) return "20 Questions ended.";
    if (end.result === "guessed")
      return `20 Questions over: the model guessed correctly after ${end.questions} ${plural(end.questions)}. Answers given: ${answered}.`;
    if (end.result === "gaveUp")
      return `20 Questions over: the player gave up after ${end.questions} ${plural(end.questions)}. Answers given: ${answered}.`;
    return `20 Questions over: ran out after ${MAX_QUESTIONS} questions without a correct guess. Answers given: ${answered}.`;
  });

  const phase: "empty" | "waitingFirst" | "active" | "ended" = end
    ? "ended"
    : count === 0
      ? waiting
        ? "waitingFirst"
        : "empty"
      : "active";

  const endgame = count >= ENDGAME_AT;
  const pct = Math.min(100, (count / MAX_QUESTIONS) * 100);

  const transcript = (
    <div className={s.transcript}>
      <p className={s.transcriptLabel}>Transcript</p>
      {history.length === 0 ? (
        <p className={s.transcriptEmpty}>Answers appear here as the round goes.</p>
      ) : (
        <ul className={s.qaList} ref={listRef} aria-label="Questions and answers so far">
          {history.map((item, i) => (
            <QaRow key={i} item={item} />
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide>
      <GameHeader
        title="20 Questions"
        icon={
          <span className={s.icon} aria-hidden="true">
            🤔
          </span>
        }
        stats={
          count > 0
            ? [
                { label: "Question", value: `${count} / ${MAX_QUESTIONS}` },
                { label: "Answered", value: history.length },
              ]
            : undefined
        }
        hint={count > 0 ? undefined : "Think of something. The model asks yes or no questions and tries to guess it."}
      />

      {count > 0 && (
        <div className={s.meter}>
          <div className={s.meterTrack} role="img" aria-label={`Question ${count} of ${MAX_QUESTIONS}`}>
            <span className={`${s.meterFill} ${endgame ? s.endgame : ""}`} style={sv({ "--pct": `${pct}%` })} />
          </div>
        </div>
      )}

      {phase === "empty" && (
        <div className={s.empty}>
          <p className={s.emptyLead}>
            Think of something, anything at all. The model will ask yes or no questions, one at a time, and try to
            guess it within {MAX_QUESTIONS}.
          </p>
          <button className={`${ui.btn} ${ui.primary}`} onClick={() => restart("I'm thinking of something. Start asking yes or no questions, one at a time.")}>
            I'm thinking of something
          </button>
        </div>
      )}

      {phase === "waitingFirst" && (
        <div className={s.thinking} role="status" aria-live="polite">
          <span className={s.dots} aria-hidden="true">
            <i className={s.dot} />
            <i className={s.dot} />
            <i className={s.dot} />
          </span>
          <p className={s.thinkingText}>Waiting for the first question.</p>
        </div>
      )}

      {phase === "active" && (
        <>
          {transcript}

          <div className={s.question} role="status" aria-live="polite">
            <p className={`${s.questionLabel} ${endgame ? s.endgame : ""}`}>
              Question {count} of {MAX_QUESTIONS}
              {endgame ? ", final stretch" : ""}
            </p>
            <p className={s.questionText}>{question}</p>
            {waiting && (
              <div className={s.thinking}>
                <span className={s.dots} aria-hidden="true">
                  <i className={s.dot} />
                  <i className={s.dot} />
                  <i className={s.dot} />
                </span>
                <p className={s.thinkingText}>
                  {pending ? (
                    <>
                      You answered <b>{pending}</b>, waiting for the next question.
                    </>
                  ) : (
                    "Waiting for the next question."
                  )}
                </p>
              </div>
            )}
          </div>

          <div className={s.answers} role="group" aria-label="Answer the question">
            <button
              className={`${s.answerBtn} ${s.yes}`}
              onClick={() => answer("Yes")}
              disabled={waiting}
              aria-label="Answer yes"
            >
              Yes
            </button>
            <button
              className={`${s.answerBtn} ${s.sometimes}`}
              onClick={() => answer("Sometimes")}
              disabled={waiting}
              aria-label="Answer sometimes"
            >
              Sometimes
            </button>
            <button
              className={`${s.answerBtn} ${s.no}`}
              onClick={() => answer("No")}
              disabled={waiting}
              aria-label="Answer no"
            >
              No
            </button>
          </div>

          <p className={s.hintLine}>Y, S or N answer. These two end the round any time:</p>

          <div className={s.endRow}>
            <button className={ui.btn} onClick={gotIt}>
              That's it!
            </button>
            <button className={ui.btn} onClick={giveUp}>
              Give up, I'll tell you
            </button>
          </div>
        </>
      )}

      {phase === "ended" && end && (
        <>
          {transcript}
          <div className={s.endPanel}>
            <p className={s.endTitle}>{endTitle(end)}</p>
            <p className={s.endDetail}>{endDetail(end)}</p>
            <button
              className={`${ui.btn} ${ui.primary}`}
              onClick={() => restart("New round. I'm thinking of something else, start asking yes or no questions again.")}
            >
              Play again
            </button>
          </div>
        </>
      )}

      <ControlBar>
        <button className={ui.btn} onClick={toggleFull}>
          {isFull ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </ControlBar>

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
