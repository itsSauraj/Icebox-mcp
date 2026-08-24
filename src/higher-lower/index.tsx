/**
 * @file Higher or Lower: two real-world quantities, pick the bigger one.
 *
 * The drama is entirely in the reveal, so that is where the work goes. When
 * the player commits, the challenger's number counts up from zero over about
 * 900ms rather than snapping into place, and only once it settles does the
 * verdict land. Snapping the number in removes the only tension the game has.
 *
 * A round is a carousel rather than a fresh pair each time: on a correct
 * answer the winning item slides into the left slot and a new challenger
 * arrives from the right, which is how the real game reads and which keeps the
 * player's frame of reference stable.
 *
 * Pairs come from the model and may land after mount, so the deck starts
 * deterministic (built-in pairs, in source order) and is only shuffled once
 * the player has actually started. React StrictMode double-invokes state
 * initialisers, so a shuffle in there would deal two different decks.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shuffle } from "../lib/rng";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Overlay,
  StatusLine,
  seedArray,
  useBest,
  useFullscreen,
  useGameOverReport,
  useSeed,
  useShare,
  type GameStatus,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./higherlower.module.css";

interface Pair {
  left: string;
  right: string;
  leftValue: number;
  rightValue: number;
  unit?: string;
}

/** One side of the screen. The carousel moves these between slots. */
interface Item {
  label: string;
  value: number;
  unit?: string;
}

const COUNT_MS = 900;
const SETTLE_MS = 700;

/**
 * Built-in deck, used whenever the model sends nothing usable. Figures are
 * approximate but real, and each pair is chosen so the answer is not obvious
 * from the category alone.
 */
const BUILT_IN: Pair[] = [
  { left: "Population of Tokyo", right: "Population of Delhi", leftValue: 37.4, rightValue: 33.8, unit: "million" },
  { left: "Height of the Eiffel Tower", right: "Height of the Great Pyramid", leftValue: 330, rightValue: 139, unit: "m" },
  { left: "Depth of the Mariana Trench", right: "Height of Mount Everest", leftValue: 10935, rightValue: 8849, unit: "m" },
  { left: "Length of the Nile", right: "Length of the Amazon", leftValue: 6650, rightValue: 6400, unit: "km" },
  { left: "Year the printing press arrived", right: "Year Oxford University was founded", leftValue: 1440, rightValue: 1096 },
  { left: "Bones in an adult human", right: "Bones in a newborn", leftValue: 206, rightValue: 300 },
  { left: "Moons of Jupiter", right: "Moons of Saturn", leftValue: 95, rightValue: 146 },
  { left: "Speed of a cheetah", right: "Speed of a peregrine falcon diving", leftValue: 112, rightValue: 389, unit: "km/h" },
  { left: "Countries in Africa", right: "Countries in Europe", leftValue: 54, rightValue: 44 },
  { left: "Weight of a blue whale tongue", right: "Weight of an African elephant", leftValue: 2.7, rightValue: 6, unit: "tonnes" },
  { left: "Keys on a piano", right: "Strings on a concert harp", leftValue: 88, rightValue: 47 },
  { left: "Time light takes from the Sun", right: "Time light takes from the Moon", leftValue: 499, rightValue: 1.3, unit: "seconds" },
  { left: "Everest climbers per year", right: "People who have been to space", leftValue: 800, rightValue: 700 },
  { left: "Languages spoken in India", right: "Languages spoken in Nigeria", leftValue: 447, rightValue: 520 },
  { left: "Grams of sugar in a can of cola", right: "Grams of sugar in a glazed doughnut", leftValue: 39, rightValue: 12 },
];

/** Readable figures: compact above a million, separators below, no jitter. */
function formatValue(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) {
    return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(n);
  }
  const decimals = Number.isInteger(n) ? 0 : Math.min(2, (String(n).split(".")[1] ?? "").length);
  return new Intl.NumberFormat("en", { maximumFractionDigits: decimals }).format(n);
}

/** Validate what the model sent. Equal values are already dropped server-side. */
function usablePairs(raw: unknown[]): Pair[] {
  const out: Pair[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const left = typeof p.left === "string" ? p.left.trim() : "";
    const right = typeof p.right === "string" ? p.right.trim() : "";
    const leftValue = Number(p.leftValue);
    const rightValue = Number(p.rightValue);
    if (!left || !right) continue;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) continue;
    if (leftValue === rightValue) continue;
    const unit = typeof p.unit === "string" && p.unit.trim() ? p.unit.trim() : undefined;
    out.push({ left, right, leftValue, rightValue, unit });
  }
  return out;
}

const toItems = (p: Pair): [Item, Item] => [
  { label: p.left, value: p.leftValue, unit: p.unit },
  { label: p.right, value: p.rightValue, unit: p.unit },
];

/**
 * Counts a number up to its target. Runs on rAF so it tracks real elapsed
 * time rather than a frame count, and returns the final value immediately
 * when the viewer has asked for reduced motion.
 */
function useCountUp(target: number, run: boolean, reduced: boolean): number {
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!run) {
      setShown(0);
      return;
    }
    if (reduced) {
      setShown(target);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_MS);
      // Ease out, so the number decelerates into its final value.
      setShown(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(step);
      else setShown(target);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, run, reduced]);

  return shown;
}

type Phase = "ready" | "asking" | "revealing" | "over";

export default function HigherLower({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seedRaw = useSeed(runtime);
  const seed = useMemo(() => seedArray<unknown>(seedRaw, "pairs"), [seedRaw]);

  const [deck, setDeck] = useState<Pair[]>(() => BUILT_IN);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [streak, setStreak] = useState(0);
  const [correct, setCorrect] = useState<boolean | null>(null);
  const [reduced, setReduced] = useState(false);
  const [exhausted, setExhausted] = useState(false);

  // Carousel slots. `left` is the incumbent, `right` is the challenger.
  const [left, setLeft] = useState<Item>(() => toItems(BUILT_IN[0])[0]);
  const [right, setRight] = useState<Item>(() => toItems(BUILT_IN[0])[1]);
  const [sliding, setSliding] = useState(false);

  const usingModelDeck = useRef(false);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // A model deck replaces the built-in one and restarts the run. Guarded by a
  // signature so a resent identical notification does not wipe a game in
  // progress.
  const sig = useMemo(() => JSON.stringify(seed), [seed]);
  const lastSig = useRef("");
  useEffect(() => {
    if (sig === lastSig.current) return;
    lastSig.current = sig;
    const fresh = usablePairs(seed);
    if (fresh.length === 0) return;
    usingModelDeck.current = true;
    setDeck(fresh);
    setIndex(0);
    setStreak(0);
    setCorrect(null);
    setExhausted(false);
    setPhase("ready");
    const [a, b] = toItems(fresh[0]);
    setLeft(a);
    setRight(b);
  }, [sig, seed]);

  const best = useBest(streak);

  const start = useCallback(() => {
    // Shuffling here rather than in an initialiser: StrictMode runs
    // initialisers twice and would deal two different decks.
    setDeck((d) => {
      const shuffled = shuffle(d);
      const [a, b] = toItems(shuffled[0]);
      setLeft(a);
      setRight(b);
      return shuffled;
    });
    setIndex(0);
    setStreak(0);
    setCorrect(null);
    setExhausted(false);
    setPhase("asking");
  }, []);

  const revealValue = phase === "revealing" || phase === "over" ? right.value : 0;
  const shownRight = useCountUp(revealValue, phase === "revealing" || phase === "over", reduced);

  // Advance once the count-up has settled, so the verdict never lands on top of
  // a number that is still moving.
  useEffect(() => {
    if (phase !== "revealing") return;
    const wait = reduced ? 450 : COUNT_MS + SETTLE_MS;
    const id = window.setTimeout(() => {
      if (correct === false) {
        setPhase("over");
        return;
      }
      const next = index + 1;
      if (next >= deck.length) {
        setExhausted(true);
        setPhase("over");
        return;
      }
      // The challenger becomes the incumbent, and the next pair's right-hand
      // item arrives as the new challenger.
      const [, incoming] = toItems(deck[next]);
      setSliding(true);
      setLeft(right);
      setRight(incoming);
      setIndex(next);
      setPhase("asking");
      window.setTimeout(() => setSliding(false), reduced ? 0 : 420);
    }, wait);
    return () => window.clearTimeout(id);
  }, [phase, correct, index, deck, right, reduced]);

  const guess = useCallback(
    (higher: boolean) => {
      if (phase !== "asking") return;
      const isHigher = right.value > left.value;
      const got = higher === isHigher;
      setCorrect(got);
      setStreak((n) => (got ? n + 1 : n));
      setPhase("revealing");
    },
    [phase, right.value, left.value],
  );

  const status: GameStatus = phase === "over" ? "over" : phase === "ready" ? "ready" : "playing";

  useGameOverReport(runtime, phase === "over", () =>
    exhausted
      ? `Higher or Lower: cleared all ${deck.length} pairs with a streak of ${streak}.`
      : `Higher or Lower: streak of ${streak}. ${right.label} was ${formatValue(right.value)}${right.unit ? ` ${right.unit}` : ""}, ${left.label} was ${formatValue(left.value)}${left.unit ? ` ${left.unit}` : ""}.`,
  );

  const askMore = useCallback(() => {
    void share(
      "Fifteen more higher-or-lower pairs please, with real figures.",
      `Higher or Lower: finished with a streak of ${streak}.`,
    );
  }, [share, streak]);

  const revealed = phase === "revealing" || phase === "over";

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Higher or Lower"
        stats={[
          { label: "Streak", value: streak },
          { label: "Best", value: best },
        ]}
        hint={phase === "asking" ? "Is the right-hand figure higher or lower?" : undefined}
      />

      <div className={s.stage}>
        <div className={`${s.card} ${s.known} ${sliding && !reduced ? s.slideIn : ""}`}>
          <p className={s.label}>{left.label}</p>
          <p className={s.value}>
            {formatValue(left.value)}
            {left.unit && <span className={s.unit}>{left.unit}</span>}
          </p>
        </div>

        <div className={s.versus} aria-hidden="true">
          vs
        </div>

        <div
          className={`${s.card} ${s.mystery} ${revealed && correct === true ? s.right : ""} ${
            revealed && correct === false ? s.wrong : ""
          } ${sliding && !reduced ? s.slideIn : ""}`}
        >
          <p className={s.label}>{right.label}</p>
          {revealed ? (
            <p className={s.value}>
              {formatValue(reduced ? right.value : Math.round(shownRight * 10) / 10)}
              {right.unit && <span className={s.unit}>{right.unit}</span>}
            </p>
          ) : (
            <div className={s.choices} role="group" aria-label="Is it higher or lower">
              <button className={`${ui.btn} ${ui.primary}`} onClick={() => guess(true)} disabled={phase !== "asking"}>
                Higher
              </button>
              <button className={ui.btn} onClick={() => guess(false)} disabled={phase !== "asking"}>
                Lower
              </button>
            </div>
          )}
        </div>

        <Overlay
          status={status}
          title={phase === "ready" ? "Higher or Lower" : exhausted ? "Deck cleared" : "Wrong"}
          detail={
            phase === "ready"
              ? `${deck.length} pairs. Guess whether the right-hand figure is higher or lower than the left.`
              : `Streak of ${streak}.`
          }
          action={phase === "ready" ? "Play" : "Play again"}
          onAction={start}
          secondary={phase === "over" ? "More pairs" : undefined}
          onSecondary={phase === "over" ? askMore : undefined}
        />
      </div>

      {/* Announced only once the number has settled, so a screen reader is not
          read a counter mid-animation. */}
      <p className={ui.status} role="status" aria-live="polite">
        {phase === "over" || (revealed && reduced)
          ? `${right.label}: ${formatValue(right.value)}${right.unit ? ` ${right.unit}` : ""}. ${
              correct ? "Correct" : "Wrong"
            }.`
          : ""}
      </p>

      {!usingModelDeck.current && phase === "ready" && (
        <Notice>Using the built-in deck. Ask for a topic and the model will send its own pairs.</Notice>
      )}

      <ControlBar>
        <button className={ui.btn} onClick={start}>
          Restart
        </button>
        <button className={ui.btn} onClick={toggleFull}>
          {isFull ? "Exit fullscreen" : "Fullscreen"}
        </button>
        <button className={ui.btn} onClick={askMore} disabled={phase === "asking"}>
          More pairs
        </button>
      </ControlBar>

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
