/**
 * @file Blackjack: six-deck shoe, chips, split and double down.
 *
 * The rules are the substance, so they are stated on screen and implemented
 * exactly: dealer stands on all 17 including soft, blackjack pays 3:2 and only
 * on the first two cards, insurance pays 2:1, split aces take one card each
 * and cannot be hit again.
 *
 * Ace handling is the one piece worth reading twice. `handValue` counts every
 * ace as 1 and then promotes a single ace to 11 if that still fits under 21,
 * which is the only promotion that can ever help: two aces at 11 is already 22.
 * A hand is "soft" exactly when that promotion happened, and that flag is what
 * the dealer rule and the display both key off.
 *
 * The shoe is not dealt in a state initialiser. React StrictMode double-invokes
 * initialisers, so a shuffled shoe there would produce two different decks.
 * Everything starts empty and the first shuffle happens when a bet is placed.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { shuffle } from "../lib/rng";
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
import s from "./blackjack.module.css";

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"] as const;
const SUITS = ["♠", "♥", "♦", "♣"] as const;
type Rank = (typeof RANKS)[number];
type Suit = (typeof SUITS)[number];

interface Card {
  rank: Rank;
  suit: Suit;
  /** Stable id so React keeps a card's node when hands are rebuilt. */
  id: number;
}

const DECKS = 6;
const START_CHIPS = 500;
const CHIP_VALUES = [5, 25, 100];

const isRed = (c: Card) => c.suit === "♥" || c.suit === "♦";
const cardPoints = (r: Rank) => (r === "A" ? 1 : r === "J" || r === "Q" || r === "K" ? 10 : Number(r));

/**
 * Best total for a hand, plus whether it is soft. Count every ace as 1, then
 * promote one ace to 11 if it still fits: promoting a second would always bust,
 * since two elevens is 22.
 */
function handValue(cards: Card[]): { total: number; soft: boolean } {
  let total = cards.reduce((n, c) => n + cardPoints(c.rank), 0);
  const hasAce = cards.some((c) => c.rank === "A");
  if (hasAce && total + 10 <= 21) return { total: total + 10, soft: true };
  return { total, soft: false };
}

/** Blackjack is an ace plus a ten-value card, on the first two cards only. */
const isBlackjack = (cards: Card[]) => cards.length === 2 && handValue(cards).total === 21;

function freshShoe(startId: number): Card[] {
  const cards: Card[] = [];
  let id = startId;
  for (let d = 0; d < DECKS; d++) {
    for (const suit of SUITS) for (const rank of RANKS) cards.push({ rank, suit, id: id++ });
  }
  return shuffle(cards);
}

type HandOutcome = "blackjack" | "win" | "push" | "lose" | "bust" | null;

interface Hand {
  cards: Card[];
  bet: number;
  doubled: boolean;
  /** Split aces get exactly one card and are then closed. */
  closed: boolean;
  outcome: HandOutcome;
  payout: number;
  fromSplitAce: boolean;
}

type Phase = "betting" | "insurance" | "player" | "dealer" | "settled";

const newHand = (bet: number, fromSplitAce = false): Hand => ({
  cards: [],
  bet,
  doubled: false,
  closed: false,
  outcome: null,
  payout: 0,
  fromSplitAce,
});

export default function Blackjack({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);

  const [shoe, setShoe] = useState<Card[]>([]);
  const [nextId, setNextId] = useState(0);
  const [chips, setChips] = useState(START_CHIPS);
  const [bet, setBet] = useState(0);
  const [lastBet, setLastBet] = useState(0);
  const [hands, setHands] = useState<Hand[]>([]);
  const [activeHand, setActiveHand] = useState(0);
  const [dealer, setDealer] = useState<Card[]>([]);
  const [holeDown, setHoleDown] = useState(true);
  const [phase, setPhase] = useState<Phase>("betting");
  const [insurance, setInsurance] = useState(0);
  const [message, setMessage] = useState("");
  const [handsPlayed, setHandsPlayed] = useState(0);

  const best = useBest(chips);

  /** Draw from the shoe, reshuffling when it drops below a quarter. */
  const draw = useCallback(
    (count: number): Card[] => {
      let pool = shoe;
      let id = nextId;
      if (pool.length < DECKS * 52 * 0.25 + count) {
        pool = freshShoe(id);
        id += pool.length;
      }
      const taken = pool.slice(0, count);
      setShoe(pool.slice(count));
      setNextId(id);
      return taken;
    },
    [shoe, nextId],
  );

  const addChipToBet = useCallback(
    (v: number) => {
      if (phase !== "betting") return;
      if (v > chips - bet) return;
      setBet((b) => b + v);
    },
    [phase, chips, bet],
  );

  const deal = useCallback(() => {
    if (phase !== "betting" || bet <= 0 || bet > chips) return;
    const cards = draw(4);
    const player = newHand(bet);
    player.cards = [cards[0], cards[2]];
    const dealerCards = [cards[1], cards[3]];

    setChips((c) => c - bet);
    setLastBet(bet);
    setHands([player]);
    setActiveHand(0);
    setDealer(dealerCards);
    setHoleDown(true);
    setInsurance(0);
    setMessage("");
    setHandsPlayed((n) => n + 1);

    // Insurance is offered before anything else when the up card is an ace.
    if (dealerCards[0].rank === "A") setPhase("insurance");
    else if (isBlackjack(player.cards)) setPhase("dealer");
    else setPhase("player");
  }, [phase, bet, chips, draw]);

  /** Settle every hand against the dealer's final total. */
  const settle = useCallback(
    (dealerCards: Card[], playerHands: Hand[], insuranceBet: number) => {
      const d = handValue(dealerCards);
      const dealerBj = isBlackjack(dealerCards);
      let returned = 0;
      const settled = playerHands.map((h) => {
        const p = handValue(h.cards);
        let outcome: HandOutcome;
        let payout = 0;
        if (p.total > 21) {
          outcome = "bust";
        } else if (isBlackjack(h.cards) && !h.fromSplitAce) {
          if (dealerBj) {
            outcome = "push";
            payout = h.bet;
          } else {
            outcome = "blackjack";
            payout = h.bet + Math.floor(h.bet * 1.5);
          }
        } else if (dealerBj) {
          outcome = "lose";
        } else if (d.total > 21 || p.total > d.total) {
          outcome = "win";
          payout = h.bet * 2;
        } else if (p.total === d.total) {
          outcome = "push";
          payout = h.bet;
        } else {
          outcome = "lose";
        }
        returned += payout;
        return { ...h, outcome, payout };
      });

      // Insurance pays 2:1 and is settled separately from the hand.
      if (insuranceBet > 0 && dealerBj) returned += insuranceBet * 3;

      setHands(settled);
      setChips((c) => c + returned);
      setPhase("settled");

      const parts = settled.map((h) => {
        const p = handValue(h.cards);
        if (h.outcome === "blackjack") return `Blackjack, pays ${h.payout - h.bet}`;
        if (h.outcome === "bust") return `Bust on ${p.total}`;
        if (h.outcome === "push") return `Push on ${p.total}`;
        if (h.outcome === "win") return `${p.total} beats ${d.total > 21 ? "a dealer bust" : d.total}`;
        return `${p.total} loses to ${dealerBj ? "dealer blackjack" : d.total}`;
      });
      setMessage(parts.join(". ") + ".");
    },
    [],
  );

  /** Dealer draws to 17, standing on all 17 including soft. */
  const playDealer = useCallback(
    (playerHands: Hand[], insuranceBet: number) => {
      setHoleDown(false);
      const allBust = playerHands.every((h) => handValue(h.cards).total > 21);
      let cards = dealer.slice();

      if (!allBust) {
        // Deal from a local copy so several draws in one pass stay consistent.
        let pool = shoe;
        let id = nextId;
        const take = () => {
          if (pool.length < 1) {
            pool = freshShoe(id);
            id += pool.length;
          }
          const c = pool[0];
          pool = pool.slice(1);
          return c;
        };
        while (handValue(cards).total < 17) cards = [...cards, take()];
        setShoe(pool);
        setNextId(id);
        setDealer(cards);
      }

      settle(cards, playerHands, insuranceBet);
    },
    [dealer, shoe, nextId, settle],
  );

  /** Move to the next unfinished hand, or hand over to the dealer. */
  const advance = useCallback(
    (updated: Hand[], from: number) => {
      for (let i = from + 1; i < updated.length; i++) {
        if (!updated[i].closed && handValue(updated[i].cards).total <= 21) {
          setActiveHand(i);
          return;
        }
      }
      setPhase("dealer");
      playDealer(updated, insurance);
    },
    [playDealer, insurance],
  );

  const hit = useCallback(() => {
    if (phase !== "player") return;
    const [card] = draw(1);
    setHands((hs) => {
      const next = hs.slice();
      const h = { ...next[activeHand] };
      h.cards = [...h.cards, card];
      const v = handValue(h.cards);
      if (v.total >= 21) h.closed = true;
      next[activeHand] = h;
      if (h.closed) queueMicrotask(() => advance(next, activeHand));
      return next;
    });
  }, [phase, activeHand, draw, advance]);

  const stand = useCallback(() => {
    if (phase !== "player") return;
    setHands((hs) => {
      const next = hs.slice();
      next[activeHand] = { ...next[activeHand], closed: true };
      queueMicrotask(() => advance(next, activeHand));
      return next;
    });
  }, [phase, activeHand, advance]);

  const canDouble = useMemo(() => {
    const h = hands[activeHand];
    return phase === "player" && h && h.cards.length === 2 && !h.fromSplitAce && chips >= h.bet;
  }, [phase, hands, activeHand, chips]);

  const doubleDown = useCallback(() => {
    if (!canDouble) return;
    const [card] = draw(1);
    setHands((hs) => {
      const next = hs.slice();
      const h = { ...next[activeHand] };
      setChips((c) => c - h.bet);
      h.bet *= 2;
      h.doubled = true;
      h.cards = [...h.cards, card];
      h.closed = true;
      next[activeHand] = h;
      queueMicrotask(() => advance(next, activeHand));
      return next;
    });
  }, [canDouble, activeHand, draw, advance]);

  const canSplit = useMemo(() => {
    const h = hands[activeHand];
    return (
      phase === "player" &&
      h &&
      hands.length === 1 &&
      h.cards.length === 2 &&
      h.cards[0].rank === h.cards[1].rank &&
      chips >= h.bet
    );
  }, [phase, hands, activeHand, chips]);

  const split = useCallback(() => {
    if (!canSplit) return;
    const h = hands[activeHand];
    const aces = h.cards[0].rank === "A";
    const extra = draw(2);
    setChips((c) => c - h.bet);
    const a = newHand(h.bet, aces);
    const b = newHand(h.bet, aces);
    a.cards = [h.cards[0], extra[0]];
    b.cards = [h.cards[1], extra[1]];
    // Split aces take one card each and are closed immediately.
    if (aces) {
      a.closed = true;
      b.closed = true;
    }
    const next = [a, b];
    setHands(next);
    setActiveHand(0);
    if (aces) {
      setPhase("dealer");
      queueMicrotask(() => playDealer(next, insurance));
    }
  }, [canSplit, hands, activeHand, draw, playDealer, insurance]);

  const takeInsurance = useCallback(
    (yes: boolean) => {
      if (phase !== "insurance") return;
      const amount = yes ? Math.floor(hands[0].bet / 2) : 0;
      if (amount > 0) {
        setChips((c) => c - amount);
        setInsurance(amount);
      }
      if (isBlackjack(dealer) || isBlackjack(hands[0].cards)) {
        setPhase("dealer");
        queueMicrotask(() => playDealer(hands, amount));
      } else {
        setPhase("player");
      }
    },
    [phase, hands, dealer, playDealer],
  );

  const nextRound = useCallback(() => {
    setHands([]);
    setDealer([]);
    setHoleDown(true);
    setInsurance(0);
    setMessage("");
    setActiveHand(0);
    setBet(Math.min(lastBet, chips));
    setPhase("betting");
  }, [lastBet, chips]);

  const resetChips = useCallback(() => {
    setChips(START_CHIPS);
    setBet(0);
    setLastBet(0);
    nextRound();
  }, [nextRound]);

  const broke = chips <= 0 && phase === "betting" && bet === 0;

  useGameOverReport(runtime, broke, () => `Blackjack: out of chips after ${handsPlayed} hands.`);

  const tell = useCallback(() => {
    void share(
      `I finished blackjack with ${chips} chips from ${START_CHIPS}, over ${handsPlayed} hands.`,
      `Blackjack: best chip total this session was ${best}.`,
    );
  }, [share, chips, handsPlayed, best]);

  const dealerShown = holeDown ? dealer.slice(0, 1) : dealer;
  const dealerValue = handValue(dealerShown);

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Blackjack"
        stats={[
          { label: "Chips", value: chips },
          { label: "Hands", value: handsPlayed },
          { label: "Best", value: best },
        ]}
        hint={phase === "betting" ? "Place a bet" : undefined}
      />

      <section className={s.table} aria-label="Table">
        <div className={s.side}>
          <p className={s.sideLabel}>
            Dealer
            {dealer.length > 0 && (
              <span className={s.total}>
                {holeDown ? dealerValue.total : `${dealerValue.total}${dealerValue.soft ? " soft" : ""}`}
              </span>
            )}
          </p>
          <div className={s.cards}>
            {dealer.map((c, i) => (
              <PlayingCard key={c.id} card={c} facedown={holeDown && i === 1} index={i} />
            ))}
          </div>
        </div>

        <div className={s.side}>
          <p className={s.sideLabel}>
            You
            {hands.length > 1 && <span className={s.muted}>{hands.length} hands</span>}
          </p>
          <div className={s.handRow}>
            {hands.map((h, hi) => {
              const v = handValue(h.cards);
              return (
                <div
                  key={hi}
                  className={`${s.hand} ${hands.length > 1 && hi === activeHand && phase === "player" ? s.handActive : ""}`}
                >
                  <div className={s.cards}>
                    {h.cards.map((c, i) => (
                      <PlayingCard key={c.id} card={c} index={i} />
                    ))}
                  </div>
                  <p className={s.handMeta}>
                    <span className={s.total}>
                      {v.soft && v.total !== 21 ? `${v.total - 10} or ${v.total}` : v.total}
                    </span>
                    <span className={s.muted}>{h.bet} chips{h.doubled ? ", doubled" : ""}</span>
                    {h.outcome && <span className={`${s.outcome} ${s[h.outcome]}`}>{h.outcome}</span>}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      </section>

      <p className={s.message} role="status" aria-live="polite">
        {message}
      </p>

      {phase === "betting" && (
        <>
          <div className={s.betRow}>
            <span className={s.betLabel}>Bet</span>
            <b className={s.betValue}>{bet}</b>
            {CHIP_VALUES.map((v) => (
              <button
                key={v}
                className={`${s.chip} ${s[`chip${v}`]}`}
                onClick={() => addChipToBet(v)}
                disabled={v > chips - bet}
                aria-label={`Add ${v} chips to the bet`}
              >
                {v}
              </button>
            ))}
            <button className={ui.btn} onClick={() => setBet(0)} disabled={bet === 0}>
              Clear
            </button>
          </div>
          <ControlBar>
            <button className={`${ui.btn} ${ui.primary}`} onClick={deal} disabled={bet <= 0}>
              Deal
            </button>
            {lastBet > 0 && lastBet <= chips && (
              <button className={ui.btn} onClick={() => setBet(lastBet)}>
                Rebet {lastBet}
              </button>
            )}
          </ControlBar>
        </>
      )}

      {phase === "insurance" && (
        <ControlBar>
          <span className={s.prompt}>Dealer shows an ace. Insurance?</span>
          <button
            className={`${ui.btn} ${ui.primary}`}
            onClick={() => takeInsurance(true)}
            disabled={chips < Math.floor(hands[0]?.bet / 2)}
          >
            Insure {Math.floor((hands[0]?.bet ?? 0) / 2)}
          </button>
          <button className={ui.btn} onClick={() => takeInsurance(false)}>
            No thanks
          </button>
        </ControlBar>
      )}

      {phase === "player" && (
        <ControlBar>
          <button className={`${ui.btn} ${ui.primary}`} onClick={hit}>
            Hit
          </button>
          <button className={ui.btn} onClick={stand}>
            Stand
          </button>
          <button className={ui.btn} onClick={doubleDown} disabled={!canDouble}>
            Double
          </button>
          <button className={ui.btn} onClick={split} disabled={!canSplit}>
            Split
          </button>
        </ControlBar>
      )}

      {phase === "settled" && (
        <ControlBar>
          <button className={`${ui.btn} ${ui.primary}`} onClick={nextRound}>
            Next hand
          </button>
          <button className={ui.btn} onClick={tell}>
            Tell the model
          </button>
        </ControlBar>
      )}

      {broke && (
        <ControlBar>
          <button className={`${ui.btn} ${ui.primary}`} onClick={resetChips}>
            Buy back in
          </button>
        </ControlBar>
      )}

      <Notice>
        Six decks. Dealer stands on all 17. Blackjack pays 3:2, insurance 2:1. One split, and split aces
        take one card each.
      </Notice>

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}

/** A card. Deals in with a short stagger so a round has rhythm. */
function PlayingCard({ card, facedown, index }: { card: Card; facedown?: boolean; index: number }) {
  return (
    <span
      className={`${s.card} ${facedown ? s.down : ""} ${isRed(card) ? s.red : s.black}`}
      style={{ animationDelay: `${Math.min(index, 5) * 90}ms` }}
      role="img"
      aria-label={facedown ? "Face-down card" : `${card.rank} of ${card.suit}`}
    >
      {facedown ? (
        <span className={s.backPattern} aria-hidden="true" />
      ) : (
        <>
          <span className={s.corner}>{card.rank}</span>
          <span className={s.pip}>{card.suit}</span>
        </>
      )}
    </span>
  );
}
