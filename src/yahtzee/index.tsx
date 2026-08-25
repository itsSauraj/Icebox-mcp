/**
 * @file Yahtzee: five dice, three rolls a turn, thirteen boxes.
 *
 * The scorecard is the game, so the important feature is not the dice but the
 * preview: after any roll, every unfilled box shows what the current dice
 * would score there. Without it the player is doing arithmetic instead of
 * playing, and the whole thing collapses into a chore.
 *
 * Scoring follows the standard rules, including the two that are commonly got
 * wrong: three and four of a kind score the sum of ALL five dice, not just the
 * matching ones, and zero is always a legal score in any box so a player can
 * always take a turn even when the dice are useless.
 *
 * Yahtzee bonuses (each additional Yahtzee after a scored 50) are worth 100 and
 * the joker rules are applied for placement. Both are stated on screen.
 *
 * Dice start unrolled. React StrictMode double-invokes state initialisers, so
 * rolling in one would produce two different opening throws.
 */
import { Fragment, useCallback, useMemo, useRef, useState } from "react";
import { randInt } from "../lib/rng";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  StatusLine,
  useBest,
  useFullscreen,
  useGameOverReport,
  useShare,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import s from "./yahtzee.module.css";

const DICE = 5;
const ROLLS_PER_TURN = 3;
const UPPER_BONUS_AT = 63;
const UPPER_BONUS = 35;

type BoxId =
  | "ones" | "twos" | "threes" | "fours" | "fives" | "sixes"
  | "threeKind" | "fourKind" | "fullHouse" | "smallStraight" | "largeStraight" | "yahtzee" | "chance";

interface BoxDef {
  id: BoxId;
  label: string;
  hint: string;
  upper: boolean;
}

const BOXES: BoxDef[] = [
  { id: "ones", label: "Ones", hint: "Sum of 1s", upper: true },
  { id: "twos", label: "Twos", hint: "Sum of 2s", upper: true },
  { id: "threes", label: "Threes", hint: "Sum of 3s", upper: true },
  { id: "fours", label: "Fours", hint: "Sum of 4s", upper: true },
  { id: "fives", label: "Fives", hint: "Sum of 5s", upper: true },
  { id: "sixes", label: "Sixes", hint: "Sum of 6s", upper: true },
  { id: "threeKind", label: "Three of a kind", hint: "Sum of all dice", upper: false },
  { id: "fourKind", label: "Four of a kind", hint: "Sum of all dice", upper: false },
  { id: "fullHouse", label: "Full house", hint: "25", upper: false },
  { id: "smallStraight", label: "Small straight", hint: "30", upper: false },
  { id: "largeStraight", label: "Large straight", hint: "40", upper: false },
  { id: "yahtzee", label: "Yahtzee", hint: "50", upper: false },
  { id: "chance", label: "Chance", hint: "Sum of all dice", upper: false },
];

const UPPER_FACE: Partial<Record<BoxId, number>> = {
  ones: 1, twos: 2, threes: 3, fours: 4, fives: 5, sixes: 6,
};

type Card = Partial<Record<BoxId, number>>;

const counts = (dice: number[]) => {
  const c = new Array(7).fill(0) as number[];
  for (const d of dice) c[d]++;
  return c;
};

const sum = (dice: number[]) => dice.reduce((a, b) => a + b, 0);

/** Longest run of consecutive faces present. */
function longestRun(c: number[]): number {
  let best = 0;
  let run = 0;
  for (let f = 1; f <= 6; f++) {
    if (c[f] > 0) {
      run++;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * What `dice` would score in `box`.
 *
 * Three and four of a kind score the sum of all five dice, which is the rule
 * most home implementations get wrong by summing only the matching dice.
 */
function scoreFor(box: BoxId, dice: number[]): number {
  const c = counts(dice);
  const face = UPPER_FACE[box];
  if (face) return c[face] * face;

  const maxOfAKind = Math.max(...c.slice(1));
  switch (box) {
    case "threeKind":
      return maxOfAKind >= 3 ? sum(dice) : 0;
    case "fourKind":
      return maxOfAKind >= 4 ? sum(dice) : 0;
    case "fullHouse":
      // Five of a kind counts as a full house under the joker rules.
      return (c.includes(3) && c.includes(2)) || maxOfAKind === 5 ? 25 : 0;
    case "smallStraight":
      return longestRun(c) >= 4 || maxOfAKind === 5 ? 30 : 0;
    case "largeStraight":
      return longestRun(c) >= 5 || maxOfAKind === 5 ? 40 : 0;
    case "yahtzee":
      return maxOfAKind === 5 ? 50 : 0;
    case "chance":
      return sum(dice);
    default:
      return 0;
  }
}

/**
 * Joker rules: an extra Yahtzee must go in its matching upper box if that is
 * free; otherwise any lower box is open at its joker value. This returns
 * whether `box` is a legal home for the current dice.
 */
function jokerAllows(box: BoxId, dice: number[], card: Card): boolean {
  const c = counts(dice);
  const maxOfAKind = Math.max(...c.slice(1));
  if (maxOfAKind !== 5) return true;
  if (card.yahtzee === undefined || card.yahtzee === 0) return true;
  const face = dice[0];
  const matching = BOXES.find((b) => b.upper && UPPER_FACE[b.id] === face)!.id;
  if (card[matching] === undefined) return box === matching;
  return true;
}

const upperTotal = (card: Card) =>
  BOXES.filter((b) => b.upper).reduce((n, b) => n + (card[b.id] ?? 0), 0);

const lowerTotal = (card: Card) =>
  BOXES.filter((b) => !b.upper).reduce((n, b) => n + (card[b.id] ?? 0), 0);

function grandTotal(card: Card, yahtzeeBonus: number): number {
  const up = upperTotal(card);
  return up + (up >= UPPER_BONUS_AT ? UPPER_BONUS : 0) + lowerTotal(card) + yahtzeeBonus;
}

export default function Yahtzee({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);

  // Dice start unrolled: no randomness in an initialiser.
  const [dice, setDice] = useState<number[]>(() => new Array(DICE).fill(0));
  const [held, setHeld] = useState<boolean[]>(() => new Array(DICE).fill(false));
  const [rollsLeft, setRollsLeft] = useState(ROLLS_PER_TURN);
  const [rolling, setRolling] = useState(false);
  const [card, setCard] = useState<Card>({});
  const [yahtzeeBonus, setYahtzeeBonus] = useState(0);
  const [turn, setTurn] = useState(1);
  const [coach, setCoach] = useState(true);

  const rolled = dice.some((d) => d > 0);
  const filled = BOXES.filter((b) => card[b.id] !== undefined).length;
  const finished = filled === BOXES.length;
  const total = grandTotal(card, yahtzeeBonus);
  const best = useBest(finished ? total : 0);

  const roll = useCallback(() => {
    if (rollsLeft <= 0 || finished) return;
    setRolling(true);
    setDice((prev) => prev.map((d, i) => (rolled && held[i] ? d : randInt(1, 6))));
    setRollsLeft((n) => n - 1);
    window.setTimeout(() => setRolling(false), 420);
  }, [rollsLeft, finished, held, rolled]);

  const toggleHold = useCallback(
    (i: number) => {
      if (!rolled || finished) return;
      setHeld((h) => h.map((v, k) => (k === i ? !v : v)));
    },
    [rolled, finished],
  );

  /** Potential score in every unfilled box, or null when it is not legal. */
  const preview = useMemo(() => {
    const out: Partial<Record<BoxId, number | null>> = {};
    if (!rolled) return out;
    for (const b of BOXES) {
      if (card[b.id] !== undefined) continue;
      out[b.id] = jokerAllows(b.id, dice, card) ? scoreFor(b.id, dice) : null;
    }
    return out;
  }, [rolled, dice, card]);

  /** The box the coach points at: highest preview, ties to the lower section. */
  const suggested = useMemo(() => {
    if (!coach || !rolled) return null;
    let bestId: BoxId | null = null;
    let bestVal = -1;
    for (const b of BOXES) {
      const v = preview[b.id];
      if (v === undefined || v === null) continue;
      if (v > bestVal) {
        bestVal = v;
        bestId = b.id;
      }
    }
    return bestVal > 0 ? bestId : null;
  }, [coach, rolled, preview]);

  const scoreBox = useCallback(
    (box: BoxId) => {
      if (!rolled || card[box] !== undefined || finished) return;
      if (!jokerAllows(box, dice, card)) return;

      const value = scoreFor(box, dice);
      const c = counts(dice);
      const isExtraYahtzee =
        Math.max(...c.slice(1)) === 5 && card.yahtzee !== undefined && card.yahtzee > 0;

      setCard((prev) => ({ ...prev, [box]: value }));
      if (isExtraYahtzee) setYahtzeeBonus((n) => n + 100);

      setDice(new Array(DICE).fill(0));
      setHeld(new Array(DICE).fill(false));
      setRollsLeft(ROLLS_PER_TURN);
      setTurn((t) => Math.min(BOXES.length, t + 1));
    },
    [rolled, card, finished, dice],
  );

  const reset = useCallback(() => {
    setDice(new Array(DICE).fill(0));
    setHeld(new Array(DICE).fill(false));
    setRollsLeft(ROLLS_PER_TURN);
    setCard({});
    setYahtzeeBonus(0);
    setTurn(1);
  }, []);

  useGameOverReport(runtime, finished, () => {
    const up = upperTotal(card);
    return `Yahtzee finished: ${total} points. Upper ${up}${up >= UPPER_BONUS_AT ? " plus the 35 bonus" : ""}, lower ${lowerTotal(card)}${yahtzeeBonus ? `, ${yahtzeeBonus} in Yahtzee bonuses` : ""}.`;
  });

  const tell = useCallback(() => {
    void share(`I scored ${total} at Yahtzee.`, `Yahtzee: ${total} points across 13 boxes.`);
  }, [share, total]);

  const up = upperTotal(card);

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Yahtzee"
        stats={[
          { label: "Turn", value: `${Math.min(turn, BOXES.length)}/13` },
          { label: "Rolls", value: rollsLeft },
          { label: "Total", value: total },
          { label: "Best", value: best },
        ]}
        hint={finished ? undefined : rolled ? "Hold dice, then roll again or pick a box" : "Roll to start the turn"}
      />

      <div className={s.tray} role="group" aria-label="Dice">
        {dice.map((d, i) => (
          <button
            key={i}
            type="button"
            className={`${s.die} ${held[i] ? s.heldDie : ""} ${rolling && !held[i] ? s.tumble : ""}`}
            style={{ animationDelay: `${i * 55}ms` }}
            onClick={() => toggleHold(i)}
            disabled={!rolled || finished}
            aria-pressed={held[i]}
            aria-label={d === 0 ? `Die ${i + 1}, not rolled` : `Die ${i + 1}, showing ${d}${held[i] ? ", held" : ""}`}
          >
            {d === 0 ? <span className={s.blank} aria-hidden="true" /> : <Pips value={d} />}
          </button>
        ))}
      </div>

      <ControlBar>
        <button className={`${ui.btn} ${ui.primary}`} onClick={roll} disabled={rollsLeft <= 0 || finished}>
          {rolled ? `Roll again (${rollsLeft})` : "Roll"}
        </button>
        <button
          className={`${ui.btn} ${coach ? ui.primary : ""}`}
          aria-pressed={coach}
          onClick={() => setCoach((v) => !v)}
        >
          Suggest
        </button>
        <button className={ui.btn} onClick={reset}>
          New game
        </button>
      </ControlBar>

      {held.some(Boolean) && !finished && <Notice>Held dice stay put on the next roll.</Notice>}

      <table className={s.card}>
        <caption className={s.caption}>Scorecard</caption>
        <tbody>
          {BOXES.map((b, i) => {
            const scored = card[b.id];
            const p = preview[b.id];
            const isSuggested = suggested === b.id;
            const showUpperSubtotal = i === 5;
            return (
              <Fragment key={b.id}>
                <tr className={scored !== undefined ? s.done : ""}>
                  <th scope="row" className={s.boxLabel}>
                    {b.label}
                    <span className={s.boxHint}>{b.hint}</span>
                  </th>
                  <td className={s.boxCell}>
                    {scored !== undefined ? (
                      <span className={s.scored}>{scored}</span>
                    ) : p === null ? (
                      <span className={s.blocked} title="Joker rules send this Yahtzee to its upper box">
                        &mdash;
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={`${s.take} ${isSuggested ? s.suggested : ""} ${p === 0 ? s.zero : ""}`}
                        onClick={() => scoreBox(b.id)}
                        disabled={!rolled || finished}
                        aria-label={`Score ${b.label}${p !== undefined ? ` for ${p}` : ""}`}
                      >
                        {rolled ? p : ""}
                      </button>
                    )}
                  </td>
                </tr>
                {showUpperSubtotal && (
                  <tr className={s.subtotal}>
                    <th scope="row" className={s.boxLabel}>
                      Upper subtotal
                      <span className={s.boxHint}>{UPPER_BONUS} bonus at {UPPER_BONUS_AT}</span>
                    </th>
                    <td className={s.boxCell}>
                      <span className={s.scored}>
                        {up}
                        {up >= UPPER_BONUS_AT && <span className={s.bonus}>+{UPPER_BONUS}</span>}
                      </span>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {yahtzeeBonus > 0 && (
            <tr className={s.subtotal}>
              <th scope="row" className={s.boxLabel}>
                Yahtzee bonus
                <span className={s.boxHint}>100 each</span>
              </th>
              <td className={s.boxCell}>
                <span className={s.scored}>{yahtzeeBonus}</span>
              </td>
            </tr>
          )}
          <tr className={s.grand}>
            <th scope="row" className={s.boxLabel}>
              Total
            </th>
            <td className={s.boxCell}>
              <span className={s.scored}>{total}</span>
            </td>
          </tr>
        </tbody>
      </table>

      {finished && (
        <ControlBar>
          <button className={`${ui.btn} ${ui.primary}`} onClick={reset}>
            Play again
          </button>
          <button className={ui.btn} onClick={tell}>
            Tell the model
          </button>
        </ControlBar>
      )}

      <Notice>Joker rules apply: an extra Yahtzee goes in its matching upper box when that is still free.</Notice>

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}

/** Real pips, laid out on a 3x3 grid, rather than a digit. */
function Pips({ value }: { value: number }) {
  // Which of the nine positions are lit for each face.
  const LAYOUT: Record<number, number[]> = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };
  const on = new Set(LAYOUT[value] ?? []);
  return (
    <span className={s.pips} aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={on.has(i) ? s.pipOn : s.pipOff} />
      ))}
    </span>
  );
}
