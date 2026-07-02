/**
 * @file Coin flip with a 3D flip animation and a running Heads/Tails tally. 🪙
 */
import { useEffect, useRef, useState } from "react";
import {
  renderApp,
  Shell,
  tellModel,
  updateContext,
  useFlash,
  type AppProps,
} from "../lib/runtime";
import ui from "../lib/ui.module.css";
import c from "./coin.module.css";

type Side = "Heads" | "Tails";

function CoinApp({ runtime }: AppProps) {
  const [result, setResult] = useState<Side>("Heads");
  const [rotation, setRotation] = useState(0);
  const [flipping, setFlipping] = useState(false);
  const [tally, setTally] = useState({ Heads: 0, Tails: 0 });
  const [last, setLast] = useState<{ ctx: string; msg: string } | null>(null);
  const [status, flash] = useFlash();
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const r = (runtime.toolResult?.structuredContent as { result?: Side } | undefined)?.result;
    if (r === "Heads" || r === "Tails") {
      setResult(r);
      setRotation(r === "Tails" ? 180 : 0);
    }
  }, [runtime.toolResult]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const flip = () => {
    if (flipping) return;
    setFlipping(true);
    const res: Side = Math.random() < 0.5 ? "Heads" : "Tails";
    const offset = res === "Heads" ? 0 : 180;
    const next = Math.ceil((rotation + 720) / 360) * 360 + offset;
    setRotation(next);
    timer.current = window.setTimeout(async () => {
      setResult(res);
      setTally((t) => ({ ...t, [res]: t[res] + 1 }));
      setFlipping(false);
      setLast({ ctx: `Coin flip result: ${res}.`, msg: `The coin landed on ${res}! 🪙` });
      void updateContext(runtime, `Coin flip result: ${res}.`); // silent
    }, 950);
  };

  const tell = async () => {
    if (!last) return;
    const ok = await tellModel(runtime, last.msg, last.ctx);
    flash(runtime.standalone ? "Preview (not sent)" : ok ? "Sent to chat" : "Couldn't send");
  };

  return (
    <Shell runtime={runtime}>
      <h1 className={ui.title}>🪙 Coin Flip</h1>

      <div className={ui.stage}>
        <div className={c.scene}>
          <div className={c.coin} style={{ transform: `rotateX(${rotation}deg)` }}>
            <div className={`${c.face} ${c.front}`}>H</div>
            <div className={`${c.face} ${c.back}`}>T</div>
          </div>
        </div>
      </div>

      <p className={ui.resultBig} aria-live="polite">{flipping ? "…" : result}</p>

      <div className={ui.controls}>
        <button className={`${ui.btn} ${ui.primary}`} onClick={flip} disabled={flipping}>
          {flipping ? "Flipping…" : "Flip coin"}
        </button>
        <button className={ui.btn} onClick={tell} disabled={flipping || !last}>Tell the model</button>
      </div>

      <div className={ui.tally}>
        <span>Heads <b>{tally.Heads}</b></span>
        <span>Tails <b>{tally.Tails}</b></span>
      </div>

      <p className={ui.status}>{status}</p>
    </Shell>
  );
}

renderApp({ name: "Coin Flip App", version: "1.0.0" }, CoinApp);
