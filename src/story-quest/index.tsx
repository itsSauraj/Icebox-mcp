/**
 * @file Story Quest: a branching adventure the model writes one beat at a time.
 *
 * There is no game engine here. The loop is the model:
 *
 *   1. `useSeed` delivers a beat (prose, 2 to 4 choices, HP, inventory).
 *   2. The player picks a choice.
 *   3. `share` puts that choice in the chat, which costs one model turn. The
 *      model calls the tool again with the next beat and a new seed arrives.
 *
 * Two decisions worth explaining.
 *
 * **Beats accumulate.** A seed carries one beat, so the app keeps the story
 * itself. When a new beat arrives the outgoing one is pushed into `history`
 * along with the choice that left it, so the player can read back. Committing
 * happens in an effect guarded by a signature ref, which makes it idempotent
 * under StrictMode's double-invoked effects and under hosts that resend an
 * identical notification.
 *
 * **Waiting is explicit.** Between `share` and the next seed there is a round
 * trip of unknown length. During it every choice is disabled and the chosen
 * card stays marked, so a double tap cannot spend two model turns.
 *
 * Presentation is the value: the scene is set as a page of a book, at a ~60
 * character measure with a serif stack and a drop cap on the opening beat. All
 * atmosphere is CSS, no images and no network.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  StatusLine,
  seedArray,
  seedNumber,
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
import s from "./story.module.css";

const MAX_CHOICES = 4;
const MAX_ITEMS = 12;
/** How many beats the pip row assumes a story runs, matching the tool's advice. */
const PIP_TARGET = 12;

const GENRE_IDEAS = ["haunted lighthouse", "deep space salvage", "rain-soaked noir"];

/** One beat as the app holds it, after the seed has been read. */
interface Beat {
  genre: string;
  scene: string;
  choices: string[];
  hp: number;
  inventory: string[];
  index: number;
  ending: boolean;
}

/** A beat the player has left behind, with the choice that ended it. */
interface PastBeat {
  index: number;
  scene: string;
  choice: string;
}

/** What changed on arriving at the current beat, for the HP and pickup cues. */
interface Change {
  /** Bumped on every commit so an animation can be replayed by remounting. */
  nth: number;
  hpDelta: number;
  fresh: string[];
}

const NO_CHANGE: Change = { nth: 0, hpDelta: 0, fresh: [] };

/** Trim and cap a list of model strings. The server already validated these. */
function cleanStrings(raw: unknown[], limit: number, maxLen: number): string[] {
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t) continue;
    out.push(t.length > maxLen ? t.slice(0, maxLen) : t);
    if (out.length >= limit) break;
  }
  return out;
}

const hpClass = (hp: number) => (hp <= 25 ? s.critical : hp <= 55 ? s.hurt : s.ok);

/** Health bar. The fill CSS-transitions its width, so a hit reads as movement. */
function HpBar({ hp, delta, nth }: { hp: number; delta: number; nth: number }) {
  return (
    <div className={s.hpRow}>
      <span className={s.hpLabel}>HP</span>
      <div className={`${s.hpTrack} ${hpClass(hp)}`} role="img" aria-label={`Health ${hp} of 100`}>
        <span className={s.hpFill} style={sv({ "--pct": `${hp}%` })} />
      </div>
      <b className={s.hpNum}>{hp}</b>
      {/* Keyed on the commit count so the badge remounts and replays. */}
      {delta !== 0 && (
        <span key={nth} className={`${s.delta} ${delta < 0 ? s.dmg : s.heal}`}>
          {delta > 0 ? `+${delta}` : delta}
        </span>
      )}
    </div>
  );
}

function Inventory({ items, fresh }: { items: string[]; fresh: string[] }) {
  if (items.length === 0) return <p className={s.invEmpty}>Carrying nothing</p>;
  return (
    <ul className={s.inv} aria-label="Carrying">
      {items.map((item, i) => {
        const isNew = fresh.includes(item);
        return (
          <li key={`${i}-${item}`} className={`${s.chip} ${isNew ? s.fresh : ""}`}>
            {item}
            {isNew && <span className={s.newTag}>new</span>}
          </li>
        );
      })}
    </ul>
  );
}

/** Beats so far as a row of pips, so progress toward an ending is visible. */
function Pips({ beats }: { beats: number }) {
  const total = Math.max(PIP_TARGET, beats);
  return (
    <div className={s.pips} aria-hidden="true">
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`${s.pip} ${i < beats ? s.pipOn : ""}`} />
      ))}
    </div>
  );
}

/** Collapsed log of everything already read, scrollable when opened. */
function History({
  past,
  open,
  onToggle,
}: {
  past: PastBeat[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={s.hist}>
      <button className={s.histToggle} aria-expanded={open} onClick={onToggle}>
        <span className={`${s.caret} ${open ? s.caretOpen : ""}`} aria-hidden="true">
          ▸
        </span>
        Story so far, {past.length} {past.length === 1 ? "beat" : "beats"}
      </button>
      {open && (
        <div className={s.histBody} tabIndex={0} role="group" aria-label="Earlier beats">
          {past.map((p, i) => (
            <article key={i} className={s.past}>
              <p className={s.pastHead}>Beat {p.index}</p>
              <p className={s.pastScene}>{p.scene}</p>
              {p.choice && <p className={s.pastChoice}>You chose: {p.choice}</p>}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

export default function StoryQuest({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  const genre = seedString(seed, "genre");
  const scene = seedString(seed, "scene");
  const hp = seedNumber(seed, "hp", 100, 0, 100);
  const index = seedNumber(seed, "beat", 1, 1, 40);
  const ending = seed.ending === true;
  const choices = useMemo(
    () => cleanStrings(seedArray<unknown>(seed, "choices"), MAX_CHOICES, 120),
    [seed],
  );
  const inventory = useMemo(
    () => cleanStrings(seedArray<unknown>(seed, "inventory"), MAX_ITEMS, 40),
    [seed],
  );

  const [current, setCurrent] = useState<Beat | null>(null);
  const [past, setPast] = useState<PastBeat[]>([]);
  const [change, setChange] = useState<Change>(NO_CHANGE);
  const [pending, setPending] = useState<string | null>(null);
  const [histOpen, setHistOpen] = useState(false);

  // Mirrors of the committed state, so the commit effect can read what came
  // before without listing it as a dependency and re-running on its own writes.
  const currentRef = useRef<Beat | null>(null);
  const pendingRef = useRef<string | null>(null);
  const restartRef = useRef(false);
  const sigRef = useRef("");

  const waiting = pending !== null;

  /**
   * Commit an arriving beat. The signature covers everything the model can
   * change, so a genuine correction lands, while a resent identical
   * notification is ignored. A beat only pushes history when its prose
   * actually differs from what is on screen.
   */
  const sig = scene
    ? JSON.stringify([index, hp, ending, genre, choices, inventory, scene])
    : "";

  useEffect(() => {
    if (!sig || sigRef.current === sig) return;
    sigRef.current = sig;

    const prev = currentRef.current;
    const next: Beat = { genre, scene, choices, hp, inventory, index, ending };
    currentRef.current = next;

    const restarting = restartRef.current;
    restartRef.current = false;
    const advanced = restarting || !prev || prev.scene !== next.scene;

    if (restarting) {
      setPast([]);
    } else if (prev && advanced) {
      setPast((h) => [...h, { index: prev.index, scene: prev.scene, choice: pendingRef.current ?? "" }]);
    }

    const base = restarting ? null : prev;
    setChange((c) => ({
      nth: c.nth + 1,
      hpDelta: base ? next.hp - base.hp : 0,
      fresh: base ? next.inventory.filter((i) => !base.inventory.includes(i)) : [],
    }));

    if (advanced) {
      pendingRef.current = null;
      setPending(null);
      setHistOpen(false);
    }
    setCurrent(next);
  }, [sig, genre, scene, choices, inventory, hp, index, ending]);

  const beats = current ? Math.max(current.index, past.length + 1) : 0;

  /** Send the player's pick. One model turn, from a button they pressed. */
  const pick = useCallback(
    (choice: string) => {
      const c = currentRef.current;
      if (!c || c.ending || pendingRef.current !== null) return;
      pendingRef.current = choice;
      setPending(choice);
      void share(
        `I choose: "${choice}"`,
        `Story Quest beat ${c.index}, HP ${c.hp}, chose: ${choice}`,
      );
    },
    [share],
  );

  /** Ask for an opening beat, optionally in a named genre. */
  const begin = useCallback(
    (idea?: string) => {
      if (pendingRef.current !== null) return;
      pendingRef.current = "";
      setPending("");
      restartRef.current = true;
      void share(
        idea
          ? `Start a Story Quest adventure set in a ${idea}. Send the opening beat.`
          : "Start a Story Quest adventure. Pick a genre and send the opening beat.",
      );
    },
    [share],
  );

  /** Nudge the model when a beat arrived with prose but no usable choices. */
  const askForChoices = useCallback(() => {
    if (pendingRef.current !== null) return;
    pendingRef.current = "";
    setPending("");
    void share("Send this beat again with 2 to 4 choices.");
  }, [share]);

  // 1 to 4 select a choice, H folds the history. Everything is a button too.
  const keys: Record<string, () => void> = { h: () => setHistOpen((o) => !o) };
  if (current && !current.ending && !waiting) {
    current.choices.forEach((c, i) => {
      keys[String(i + 1)] = () => pick(c);
    });
  }
  useKeys(keys);

  useGameOverReport(runtime, current?.ending === true, () => {
    const c = currentRef.current;
    if (!c) return "Story Quest ended.";
    const carried = c.inventory.length ? c.inventory.join(", ") : "nothing";
    return `Story Quest ended after ${beats} beats in ${c.genre || "an unnamed setting"}. Final HP ${c.hp}, carrying ${carried}.`;
  });

  const waitingBlock = (
    <div className={s.pending} role="status">
      <span className={s.dots} aria-hidden="true">
        <i className={s.dot} />
        <i className={s.dot} />
        <i className={s.dot} />
      </span>
      <p className={s.pendingText}>
        The story continues
        {pending ? (
          <>
            {". You chose "}
            <b>{pending}</b>
          </>
        ) : (
          ". Waiting on the opening beat."
        )}
      </p>
    </div>
  );

  const firstBeat = current !== null && past.length === 0 && current.index <= 1;

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide>
      <GameHeader
        title="Story Quest"
        icon={
          <span className={s.icon} aria-hidden="true">
            📖
          </span>
        }
        stats={
          current
            ? [
                { label: "Beat", value: current.index },
                { label: "HP", value: current.hp },
                { label: "Carrying", value: current.inventory.length },
              ]
            : undefined
        }
        hint={current ? undefined : "A branching adventure, written as you play"}
      />

      {current && <Pips beats={beats} />}

      <div className={s.page}>
        {!current ? (
          <div className={s.start}>
            <p className={s.startLead}>
              The model writes an adventure one beat at a time. Read the scene, pick what you do,
              and the next beat comes back shaped by that choice.
            </p>
            <p className={s.startNote}>
              Health and inventory carry across beats, and somewhere around a dozen beats the story
              finds its ending.
            </p>
            <div className={s.startRow}>
              <button className={`${ui.btn} ${ui.primary}`} onClick={() => begin()} disabled={waiting}>
                Begin a story
              </button>
            </div>
            <p className={s.ideasLabel}>Or set the scene</p>
            <div className={s.ideas}>
              {GENRE_IDEAS.map((idea) => (
                <button key={idea} className={ui.btn} onClick={() => begin(idea)} disabled={waiting}>
                  {idea}
                </button>
              ))}
            </div>
            {waiting && waitingBlock}
          </div>
        ) : (
          <>
            {past.length > 0 && (
              <History past={past} open={histOpen} onToggle={() => setHistOpen((o) => !o)} />
            )}

            <section className={s.beat} aria-live="polite">
              {current.genre && <p className={s.eyebrow}>{current.genre}</p>}
              <p key={change.nth} className={`${s.scene} ${firstBeat ? s.dropCap : ""}`}>
                {current.scene}
              </p>
              {waiting && waitingBlock}
            </section>

            <div className={s.meta}>
              <HpBar hp={current.hp} delta={change.hpDelta} nth={change.nth} />
              <Inventory items={current.inventory} fresh={change.fresh} />
            </div>

            {current.ending ? (
              <div className={s.end}>
                <p className={s.endTitle}>The end</p>
                <dl className={s.endList}>
                  <dt>Setting</dt>
                  <dd>{current.genre || "Unnamed"}</dd>
                  <dt>Beats</dt>
                  <dd>{beats}</dd>
                  <dt>Final HP</dt>
                  <dd>{current.hp}</dd>
                  <dt>Carrying</dt>
                  <dd>{current.inventory.length ? current.inventory.join(", ") : "nothing"}</dd>
                </dl>
                <div className={s.startRow}>
                  <button
                    className={`${ui.btn} ${ui.primary}`}
                    onClick={() => begin()}
                    disabled={waiting}
                  >
                    Start a new story
                  </button>
                </div>
              </div>
            ) : current.choices.length > 0 ? (
              <div className={s.choices} role="group" aria-label="What do you do">
                {current.choices.map((c, i) => (
                  <button
                    key={`${i}-${c}`}
                    className={`${s.card} ${pending === c ? s.chosen : ""}`}
                    onClick={() => pick(c)}
                    disabled={waiting}
                  >
                    <span className={s.num} aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className={s.cardText}>{c}</span>
                  </button>
                ))}
              </div>
            ) : (
              <div className={s.startRow}>
                <Notice>This beat arrived without any choices.</Notice>
                <button className={ui.btn} onClick={askForChoices} disabled={waiting}>
                  Ask for choices
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {current && !current.ending && current.choices.length > 0 && (
        <p className={s.hintLine}>Press 1 to {current.choices.length} to choose, H folds the log.</p>
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
