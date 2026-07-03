/**
 * @file Dice roller. Roll 1–5 numeric dice and see the total. Toggle "Duel"
 * to roll for You vs Opponent — highest total wins.
 */
import { useEffect, useRef, useState } from "react";
import { randInt } from "../lib/rng";
import {
  renderApp,
  Shell,
  tellModel,
  updateContext,
  useFlash,
  type AppProps,
} from "../lib/runtime";
import ui from "../lib/ui.module.css";
import { DiceIcon } from "../lib/icons";
import d from "./dice.module.css";

const MAX = 5;
const PIPS: Record<number, number[]> = {
  1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8],
};

const rollDice = (n: number) => Array.from({ length: n }, () => randInt(1, 6));
const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);

function Die({ value, rolling }: { value: number; rolling: boolean }) {
  return (
    <div className={`${d.die} ${rolling ? d.rolling : ""}`} aria-label={`die showing ${value}`}>
      {Array.from({ length: 9 }, (_, i) => (
        <span key={i} className={d.cell}>{PIPS[value].includes(i) && <i className={d.pip} />}</span>
      ))}
    </div>
  );
}

interface Roll { p1: number[]; p2?: number[]; }

function DiceApp({ runtime }: AppProps) {
  const [count, setCount] = useState(1);
  const [duel, setDuel] = useState(false);
  const [roll, setRoll] = useState<Roll>(() => ({ p1: rollDice(1) }));
  const [rolling, setRolling] = useState(false);
  const [last, setLast] = useState<{ ctx: string; msg: string } | null>(null);
  const [status, flash] = useFlash();
  const timers = useRef<{ iv?: number; to?: number }>({});

  // Seed from the tool's initial roll when running in a host.
  useEffect(() => {
    const rolls = (runtime.toolResult?.structuredContent as { rolls?: number[] } | undefined)?.rolls;
    if (rolls?.length) {
      setRoll({ p1: rolls });
      setCount(rolls.length);
    }
  }, [runtime.toolResult]);

  useEffect(() => () => {
    if (timers.current.iv) clearInterval(timers.current.iv);
    if (timers.current.to) clearTimeout(timers.current.to);
  }, []);

  const doRoll = () => {
    if (rolling) return;
    setRolling(true);
    const next = (): Roll => (duel ? { p1: rollDice(count), p2: rollDice(count) } : { p1: rollDice(count) });
    timers.current.iv = window.setInterval(() => setRoll(next()), 80);
    timers.current.to = window.setTimeout(async () => {
      if (timers.current.iv) clearInterval(timers.current.iv);
      const final = next();
      setRoll(final);
      setRolling(false);

      let ctx: string, msg: string;
      if (duel && final.p2) {
        const t1 = sum(final.p1), t2 = sum(final.p2);
        const outcome = t1 > t2 ? "You win" : t2 > t1 ? "Opponent wins" : "It's a tie";
        ctx = `Dice duel — You: ${final.p1.join(", ")} (total ${t1}); Opponent: ${final.p2.join(", ")} (total ${t2}). ${outcome}.`;
        msg = `Dice duel: I rolled ${t1}, opponent rolled ${t2}. ${outcome}!`;
      } else {
        const t = sum(final.p1);
        ctx = `Rolled ${count} ${count === 1 ? "die" : "dice"}: ${final.p1.join(", ")} (total ${t}).`;
        msg = `I rolled ${final.p1.join(", ")} — total ${t}.`;
      }
      setLast({ ctx, msg });
      void updateContext(runtime, ctx); // silent — no forced model turn
    }, 600);
  };

  const tell = async () => {
    if (!last) return;
    const ok = await tellModel(runtime, last.msg, last.ctx);
    flash(runtime.standalone ? "Preview (not sent)" : ok ? "Sent to chat" : "Couldn't send");
  };

  const t1 = sum(roll.p1);
  const t2 = roll.p2 ? sum(roll.p2) : 0;
  const winner = duel && roll.p2 && !rolling
    ? (t1 > t2 ? "win" : t2 > t1 ? "lose" : "tie")
    : null;

  return (
    <Shell runtime={runtime}>
      <h1 className={ui.title}><DiceIcon className={ui.titleIcon} />Dice</h1>

      <div className={ui.stage}>
        {duel ? (
          <>
            <div className={d.side}>
              <span className={ui.subtitle}>You</span>
              <div className={d.dice}>{roll.p1.map((v, i) => <Die key={i} value={v} rolling={rolling} />)}</div>
              <strong>{t1}</strong>
            </div>
            <span className={d.vs}>vs</span>
            <div className={d.side}>
              <span className={ui.subtitle}>Opponent</span>
              <div className={d.dice}>{(roll.p2 ?? []).map((v, i) => <Die key={i} value={v} rolling={rolling} />)}</div>
              <strong>{t2}</strong>
            </div>
          </>
        ) : (
          <div className={d.side}>
            <div className={d.dice}>{roll.p1.map((v, i) => <Die key={i} value={v} rolling={rolling} />)}</div>
            <p className={ui.resultBig}>{t1}</p>
          </div>
        )}
      </div>

      {winner && (
        <span className={`${ui.banner} ${winner === "win" ? ui.win : winner === "lose" ? ui.lose : ui.tie}`}>
          {winner === "win" ? "You win!" : winner === "lose" ? "Opponent wins" : "Tie"}
        </span>
      )}

      <div className={ui.controls}>
        <div className={ui.stepper}>
          <button className={ui.icon} aria-label="Fewer dice" disabled={rolling || count <= 1} onClick={() => setCount((c) => Math.max(1, c - 1))}>−</button>
          <span>{count}</span>
          <button className={ui.icon} aria-label="More dice" disabled={rolling || count >= MAX} onClick={() => setCount((c) => Math.min(MAX, c + 1))}>+</button>
        </div>
        <label className={d.toggle}>
          <input type="checkbox" checked={duel} disabled={rolling} onChange={(e) => setDuel(e.target.checked)} />
          Duel (highest total wins)
        </label>
      </div>

      <div className={ui.controls}>
        <button className={`${ui.btn} ${ui.primary}`} onClick={doRoll} disabled={rolling}>
          {rolling ? "Rolling…" : `Roll ${count} ${count === 1 ? "die" : "dice"}`}
        </button>
        <button className={ui.btn} onClick={tell} disabled={rolling || !last}>Tell the model</button>
      </div>

      <p className={ui.status}>{status}</p>
    </Shell>
  );
}

renderApp({ name: "Dice App", version: "1.0.0" }, DiceApp);
