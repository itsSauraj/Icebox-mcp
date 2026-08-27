/**
 * @file Stone Paper Scissors against an opponent that reads you.
 *
 * Played against a random opponent this is a coin flip and not worth shipping.
 * The game only becomes a game because people are bad at being random, and an
 * opponent that exploits that turns every round into a question about your own
 * habits. Three predictors, each cheap and each targeting a documented human
 * bias:
 *
 *  - Frequency. Most people over-throw one option. Counting is enough.
 *  - First-order Markov. What you tend to throw after your own last throw,
 *    because sequences repeat more than people believe.
 *  - Win-stay, lose-shift. The strongest of the three: people tend to repeat a
 *    throw that just won and change one that just lost. Conditioning on the
 *    previous outcome catches it.
 *
 * Their distributions are blended by how much evidence each has, the most
 * likely throw is predicted, and the opponent plays whatever beats it. A little
 * deliberate randomness stops the whole thing being invertible by a player who
 * works out the rule.
 *
 * It only ever sees throws you have already made. It cannot see the current
 * one, and the round order in `resolve` makes that structural rather than a
 * promise: the opponent commits before your throw is compared. The UI says so,
 * because an opponent that wins 60% of the time will otherwise be assumed to
 * cheat.
 *
 * After each round it shows what it expected, which is the interesting part and
 * costs nothing: revealing a prediction before you choose would hand you the
 * counter and make the opponent useless.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { randInt } from "../lib/rng";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Segmented,
  StatusLine,
  seedString,
  useBest,
  useFullscreen,
  useKeys,
  useSeed,
  useShare,
} from "../lib/game";
import { updateContext, type AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./rps.module.css";

const THROWS = ["stone", "paper", "scissors"] as const;
type Throw = (typeof THROWS)[number];

/** What each throw defeats. */
const DEFEATS: Record<Throw, Throw> = { stone: "scissors", paper: "stone", scissors: "paper" };
/** What defeats each throw, which is what the opponent plays once it predicts. */
const COUNTER: Record<Throw, Throw> = { stone: "paper", paper: "scissors", scissors: "stone" };

const LABEL: Record<Throw, string> = { stone: "Stone", paper: "Paper", scissors: "Scissors" };

type Outcome = "win" | "lose" | "draw";

function judge(mine: Throw, theirs: Throw): Outcome {
  if (mine === theirs) return "draw";
  return DEFEATS[mine] === theirs ? "win" : "lose";
}

const DIFFICULTIES = ["easy", "normal", "hard"] as const;
type Difficulty = (typeof DIFFICULTIES)[number];
const isDifficulty = (v: string): v is Difficulty => (DIFFICULTIES as readonly string[]).includes(v);

/** How often the opponent throws at random instead of predicting. */
const NOISE: Record<Difficulty, number> = { easy: 1, normal: 0.3, hard: 0.12 };
/** Rounds of history before prediction is worth anything. */
const WARMUP = 3;

interface Round {
  mine: Throw;
  theirs: Throw;
  outcome: Outcome;
  /** What the opponent expected, shown after the fact. */
  predicted: Throw | null;
}

/** Counts for the three predictors, all built from the player's own history. */
interface Model {
  /** How often the player throws each option. */
  freq: Record<Throw, number>;
  /** What follows each of the player's own throws. */
  afterThrow: Record<Throw, Record<Throw, number>>;
  /** What follows each outcome, which is where win-stay lose-shift shows up. */
  afterOutcome: Record<Outcome, Record<Throw, number>>;
}

const zeroThrows = (): Record<Throw, number> => ({ stone: 0, paper: 0, scissors: 0 });

const newModel = (): Model => ({
  freq: zeroThrows(),
  afterThrow: { stone: zeroThrows(), paper: zeroThrows(), scissors: zeroThrows() },
  afterOutcome: { win: zeroThrows(), lose: zeroThrows(), draw: zeroThrows() },
});

const total = (r: Record<Throw, number>) => r.stone + r.paper + r.scissors;

/**
 * Blend the three predictors and name the most likely throw.
 *
 * Each contributes its distribution weighted by how much evidence it has, so a
 * predictor with two observations barely moves the result while one with thirty
 * dominates. Returns null when there is not enough history to bother.
 */
function predict(model: Model, history: Round[]): Throw | null {
  if (history.length < WARMUP) return null;
  const last = history[history.length - 1];

  const score = zeroThrows();
  const add = (counts: Record<Throw, number>, weight: number) => {
    const n = total(counts);
    if (n === 0) return;
    for (const t of THROWS) score[t] += (counts[t] / n) * weight * Math.min(n, 12);
  };

  // Weights reflect how predictive each signal tends to be, not a guess at
  // random: outcome conditioning is the strongest, raw frequency the weakest.
  add(model.freq, 1);
  add(model.afterThrow[last.mine], 1.6);
  add(model.afterOutcome[last.outcome], 2.2);

  let best: Throw = "stone";
  let bestScore = -1;
  for (const t of THROWS) {
    if (score[t] > bestScore) {
      bestScore = score[t];
      best = t;
    }
  }
  return bestScore > 0 ? best : null;
}

type Phase = "waiting" | "shooting" | "revealed";

export default function RockPaperScissors({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  const [difficulty, setDifficulty] = useState<Difficulty>("normal");
  const [phase, setPhase] = useState<Phase>("waiting");
  const [history, setHistory] = useState<Round[]>([]);
  const [pending, setPending] = useState<{ mine: Throw; theirs: Throw; predicted: Throw | null } | null>(null);
  const [streak, setStreak] = useState(0);

  const model = useRef<Model>(newModel());
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const d = seedString(seed, "difficulty");
    if (d && isDifficulty(d)) setDifficulty(d);
  }, [seed]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const tally = useMemo(() => {
    let won = 0;
    let lost = 0;
    let drew = 0;
    for (const r of history) {
      if (r.outcome === "win") won++;
      else if (r.outcome === "lose") lost++;
      else drew++;
    }
    return { won, lost, drew };
  }, [history]);

  const best = useBest(streak);

  /**
   * Play one round.
   *
   * The opponent commits first, from history alone, and only then is your
   * throw compared. That ordering is what makes "it cannot see your throw" a
   * property of the code rather than a claim in a comment.
   */
  const play = useCallback(
    (mine: Throw) => {
      if (phase === "shooting") return;
      window.clearTimeout(timer.current);

      const predicted = predict(model.current, history);
      const noise = NOISE[difficulty];
      const theirs: Throw =
        predicted === null || Math.random() < noise ? THROWS[randInt(0, 2)] : COUNTER[predicted];

      setPending({ mine, theirs, predicted });
      setPhase("shooting");

      timer.current = window.setTimeout(() => {
        const outcome = judge(mine, theirs);
        const round: Round = { mine, theirs, outcome, predicted };

        // Learn only after the round has resolved, so this throw informs the
        // next prediction and never the current one.
        const m = model.current;
        const prev = history[history.length - 1];
        m.freq[mine]++;
        if (prev) {
          m.afterThrow[prev.mine][mine]++;
          m.afterOutcome[prev.outcome][mine]++;
        }

        setHistory((h) => [...h, round]);
        setStreak((n) => (outcome === "win" ? n + 1 : 0));
        setPhase("revealed");
      }, 620);
    },
    [phase, history, difficulty],
  );

  const reset = useCallback(() => {
    window.clearTimeout(timer.current);
    model.current = newModel();
    setHistory([]);
    setPending(null);
    setStreak(0);
    setPhase("waiting");
  }, []);

  useKeys({
    s: () => play("stone"),
    r: () => play("stone"),
    p: () => play("paper"),
    c: () => play("scissors"),
    "1": () => play("stone"),
    "2": () => play("paper"),
    "3": () => play("scissors"),
  });

  const changeDifficulty = useCallback(
    (d: Difficulty) => {
      setDifficulty(d);
      reset();
    },
    [reset],
  );

  const last = history[history.length - 1];
  const shown = phase === "waiting" ? null : pending;

  /**
   * There is no game over here, so the model hears about the session as it
   * goes: every tenth round, once each. This is app-to-host only, so it costs
   * no model turn.
   */
  const reported = useRef(0);
  useEffect(() => {
    const rounds = history.length;
    if (rounds === 0 || rounds % 10 !== 0 || reported.current === rounds) return;
    reported.current = rounds;
    void updateContext(
      runtime,
      `Stone Paper Scissors after ${rounds} rounds: player ${tally.won}, opponent ${tally.lost}, ${tally.drew} drawn. Longest player streak ${best}.`,
    );
  }, [history.length, runtime, tally, best]);

  const tell = useCallback(() => {
    const pct = history.length ? Math.round((tally.won / history.length) * 100) : 0;
    void share(
      `I am ${tally.won} and ${tally.lost} against the Stone Paper Scissors opponent on ${difficulty}, winning ${pct}% over ${history.length} rounds.`,
      `Stone Paper Scissors: longest winning streak ${best}.`,
    );
  }, [share, tally, history.length, difficulty, best]);

  /** Your own distribution, which is fair to show and usually a surprise. */
  const spread = useMemo(() => {
    const n = history.length || 1;
    return THROWS.map((t) => ({ t, pct: Math.round((model.current.freq[t] / n) * 100) }));
  }, [history.length]);

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} className={s.root}>
      <GameHeader
        title="Stone Paper Scissors"
        stats={[
          { label: "You", value: tally.won },
          { label: "Them", value: tally.lost },
          { label: "Drawn", value: tally.drew },
          { label: "Streak", value: streak },
        ]}
        hint={phase === "waiting" && history.length === 0 ? "Pick one. It learns as you play." : undefined}
      />

      <div className={s.arena}>
        <div className={s.side}>
          <span className={s.sideLabel}>You</span>
          <div className={`${s.hand} ${phase === "shooting" ? s.shaking : ""}`}>
            {shown ? <Glyph throw={shown.mine} /> : <span className={s.waiting} aria-hidden="true" />}
          </div>
        </div>

        <div className={s.verdict}>
          {phase === "revealed" && last ? (
            <span
              className={`${s.badge} ${
                last.outcome === "win" ? s.win : last.outcome === "lose" ? s.lose : s.draw
              }`}
            >
              {last.outcome === "win" ? "You win" : last.outcome === "lose" ? "You lose" : "Draw"}
            </span>
          ) : (
            <span className={s.versus} aria-hidden="true">
              vs
            </span>
          )}
        </div>

        <div className={s.side}>
          <span className={s.sideLabel}>Them</span>
          <div className={`${s.hand} ${phase === "shooting" ? s.shaking : ""}`}>
            {phase === "revealed" && shown ? (
              <Glyph throw={shown.theirs} />
            ) : (
              <span className={s.waiting} aria-hidden="true" />
            )}
          </div>
        </div>
      </div>

      <p className={ui.status} role="status" aria-live="polite">
        {phase === "revealed" && last
          ? `${LABEL[last.mine]} against ${LABEL[last.theirs]}. ${
              last.outcome === "win" ? "You win." : last.outcome === "lose" ? "You lose." : "A draw."
            }${last.predicted ? ` It expected ${LABEL[last.predicted].toLowerCase()}.` : ""}`
          : phase === "shooting"
            ? "Stone, paper, scissors..."
            : ""}
      </p>

      <div className={s.picks} role="group" aria-label="Your throw">
        {THROWS.map((t) => (
          <button
            key={t}
            className={s.pick}
            onClick={() => play(t)}
            disabled={phase === "shooting"}
            aria-label={LABEL[t]}
          >
            <Glyph throw={t} />
            <span className={s.pickLabel}>{LABEL[t]}</span>
          </button>
        ))}
      </div>

      {history.length >= WARMUP && (
        <div className={s.readout}>
          <span className={s.readLabel}>Your habits so far</span>
          <div className={s.bars}>
            {spread.map(({ t, pct }) => (
              <div key={t} className={s.bar}>
                <span className={s.barFill} style={{ width: `${pct}%` }} />
                <span className={s.barText}>
                  {LABEL[t]} {pct}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {history.length > 0 && (
        <ul className={s.strip} aria-label="Recent rounds">
          {history
            .slice(-12)
            .reverse()
            .map((r, i) => (
              <li
                key={history.length - i}
                className={`${s.chip} ${r.outcome === "win" ? s.win : r.outcome === "lose" ? s.lose : s.draw}`}
                title={`${LABEL[r.mine]} against ${LABEL[r.theirs]}`}
              >
                {r.outcome === "win" ? "W" : r.outcome === "lose" ? "L" : "D"}
              </li>
            ))}
        </ul>
      )}

      <ControlBar>
        <Segmented label="Difficulty" options={DIFFICULTIES} value={difficulty} onChange={changeDifficulty} />
      </ControlBar>

      <ControlBar>
        <button className={ui.btn} onClick={reset}>
          Reset
        </button>
        <button className={ui.btn} onClick={tell} disabled={history.length === 0}>
          Tell the model
        </button>
      </ControlBar>

      <Notice>
        It only ever sees throws you have already made, never the current one. Being predictable is the
        only way it wins.
      </Notice>

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}

/**
 * Geometric marks rather than hands. A convincing hand at this size needs
 * detail that reads as mush; a boulder, a sheet and a pair of blades are
 * unmistakable at 40px.
 */
function Glyph({ throw: t }: { throw: Throw }) {
  if (t === "stone") {
    return (
      <svg viewBox="0 0 40 40" className={s.glyph} aria-hidden="true">
        <path
          className={s.solid}
          d="M11 9.5 22.5 6l8 6.5 1 10.5-7 9.5-11-1.5-5.5-8.5z"
        />
        <path className={s.line} d="M14 13.5 22 12l5 4M17 26l2-7 7 2" />
      </svg>
    );
  }
  if (t === "paper") {
    return (
      <svg viewBox="0 0 40 40" className={s.glyph} aria-hidden="true">
        <path className={s.solid} d="M9 5h15l7 7v23H9z" />
        <path className={s.line} d="M24 5v7h7M13 18h14M13 23h14M13 28h9" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 40 40" className={s.glyph} aria-hidden="true">
      <path className={s.line} d="M11 6l14 20M29 6L15 26" />
      <circle className={s.line} cx="12.5" cy="31" r="4.5" />
      <circle className={s.line} cx="27.5" cy="31" r="4.5" />
    </svg>
  );
}
