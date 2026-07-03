/**
 * @file Draw a card from a shuffled 52-card deck; auto-reshuffles when empty.
 */
import { useEffect, useState } from "react";
import { shuffle } from "../lib/rng";
import {
  renderApp,
  Shell,
  tellModel,
  updateContext,
  useFlash,
  type AppProps,
} from "../lib/runtime";
import ui from "../lib/ui.module.css";
import { CardIcon } from "../lib/icons";
import cs from "./card.module.css";

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"] as const;
const SUIT_NAME: Record<string, string> = { "♠": "Spades", "♥": "Hearts", "♦": "Diamonds", "♣": "Clubs" };

interface Card { rank: string; suit: string; }
const isRed = (suit: string) => suit === "♥" || suit === "♦";

function freshDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  return shuffle(deck);
}

function CardApp({ runtime }: AppProps) {
  const [{ deck, card }, setState] = useState(() => {
    const d = freshDeck();
    const c = d.pop()!;
    return { deck: d, card: c };
  });
  const [dealKey, setDealKey] = useState(0);
  const [last, setLast] = useState<{ ctx: string; msg: string } | null>(null);
  const [status, flash] = useFlash();

  useEffect(() => {
    const sc = runtime.toolResult?.structuredContent as { rank?: string; suit?: string } | undefined;
    if (sc?.rank && sc?.suit) setState((prev) => ({ ...prev, card: { rank: sc.rank!, suit: sc.suit! } }));
  }, [runtime.toolResult]);

  const draw = () => {
    setDealKey((k) => k + 1);
    const nextDeck = deck.length ? deck.slice() : freshDeck();
    const next = nextDeck.pop()!;
    setState({ deck: nextDeck, card: next });
    const ctx = `Drew the ${next.rank} of ${SUIT_NAME[next.suit]} (${next.rank}${next.suit}). ${nextDeck.length} cards remaining.`;
    setLast({ ctx, msg: `I drew the ${next.rank}${next.suit}.` });
    void updateContext(runtime, ctx); // silent
  };

  const tell = async () => {
    if (!last) return;
    const ok = await tellModel(runtime, last.msg, last.ctx);
    flash(runtime.standalone ? "Preview (not sent)" : ok ? "Sent to chat" : "Couldn't send");
  };

  const reshuffle = () => {
    const d = freshDeck();
    const c = d.pop()!;
    setDealKey((k) => k + 1);
    setState({ deck: d, card: c });
  };

  const red = isRed(card.suit);

  return (
    <Shell runtime={runtime}>
      <h1 className={ui.title}><CardIcon className={ui.titleIcon} />Draw a Card</h1>

      <div className={ui.stage}>
        <div key={dealKey} className={`${cs.card} ${red ? cs.red : ""}`} aria-label={`${card.rank} of ${SUIT_NAME[card.suit]}`}>
          <span className={cs.cornerTop}>{card.rank}<br />{card.suit}</span>
          <span className={cs.suitBig}>{card.suit}</span>
          <span className={cs.cornerBottom}>{card.rank}<br />{card.suit}</span>
        </div>
      </div>

      <p className={ui.result}>{card.rank} of {SUIT_NAME[card.suit]}</p>

      <div className={ui.controls}>
        <button className={`${ui.btn} ${ui.primary}`} onClick={draw}>Draw a card</button>
        <button className={ui.btn} onClick={reshuffle}>Reshuffle</button>
        <button className={ui.btn} onClick={tell} disabled={!last}>Tell the model</button>
      </div>

      <p className={ui.status}>{status || `${deck.length} of 52 cards remaining`}</p>
    </Shell>
  );
}

renderApp({ name: "Card Draw App", version: "1.0.0" }, CardApp);
