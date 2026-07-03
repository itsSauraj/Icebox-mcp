/**
 * @file Wheel-of-Fortune style spinner with fully editable labels — add as many
 * segments as you want, then spin.
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
import { WheelIcon } from "../lib/icons";
import w from "./wheel.module.css";

const DEFAULT_LABELS = ["100", "200", "300", "400", "500", "Bankrupt", "600", "700", "800", "Free Spin"];
const COLORS = ["#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899"];
const SIZE = 224, C = SIZE / 2, R = 106, MAX = 24;

const polar = (deg: number, r: number) => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)] as const;
};
function slicePath(start: number, end: number): string {
  const [x1, y1] = polar(start, R);
  const [x2, y2] = polar(end, R);
  const large = end - start > 180 ? 1 : 0;
  return `M${C},${C} L${x1},${y1} A${R},${R} 0 ${large} 1 ${x2},${y2} Z`;
}
const trunc = (s: string) => (s.length > 12 ? s.slice(0, 11) + "…" : s);

function WheelApp({ runtime }: AppProps) {
  const [labels, setLabels] = useState<string[]>(DEFAULT_LABELS);
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [winner, setWinner] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [last, setLast] = useState<{ ctx: string; msg: string } | null>(null);
  const [status, flash] = useFlash();
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const fromResult = (runtime.toolResult?.structuredContent as { labels?: unknown } | undefined)?.labels;
    const fromInput = runtime.toolInput?.labels;
    const seed = Array.isArray(fromResult) ? fromResult : Array.isArray(fromInput) ? fromInput : null;
    if (seed && seed.length >= 2) setLabels(seed.map(String).slice(0, MAX));
  }, [runtime.toolInput, runtime.toolResult]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const n = labels.length;
  const seg = 360 / n;

  const spin = () => {
    if (spinning || n < 2) return;
    setSpinning(true);
    setWinner(null);
    const target = randInt(0, n - 1);
    const centerAngle = target * seg + seg / 2;
    const desiredMod = (360 - centerAngle) % 360;
    const currentMod = ((rotation % 360) + 360) % 360;
    let delta = desiredMod - currentMod;
    if (delta < 0) delta += 360;
    const next = rotation + 360 * 5 + delta;
    setRotation(next);
    timer.current = window.setTimeout(() => {
      setWinner(target);
      setSpinning(false);
      const ctx = `Spun the wheel (${n} segments); it landed on "${labels[target]}".`;
      setLast({ ctx, msg: `The wheel landed on "${labels[target]}"!` });
      void updateContext(runtime, ctx); // silent
    }, 4100);
  };

  const tell = async () => {
    if (!last) return;
    const ok = await tellModel(runtime, last.msg, last.ctx);
    flash(runtime.standalone ? "Preview (not sent)" : ok ? "Sent to chat" : "Couldn't send");
  };

  const add = () => {
    const v = draft.trim();
    if (!v || spinning) return;
    setLabels((l) => (l.length >= MAX ? l : [...l, v]));
    setDraft("");
  };
  const remove = (i: number) => {
    if (spinning) return;
    setLabels((l) => (l.length > 2 ? l.filter((_, j) => j !== i) : l));
  };

  return (
    <Shell runtime={runtime}>
      <h1 className={ui.title}><WheelIcon className={ui.titleIcon} />Spin the Wheel</h1>

      <div className={ui.stage}>
        <div className={w.wheelWrap}>
          <div className={w.pointer} />
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className={w.wheel} style={{ transform: `rotate(${rotation}deg)` }}>
            {labels.map((label, i) => {
              const start = i * seg;
              const centerAngle = start + seg / 2;
              const [lx, ly] = polar(centerAngle, R * 0.62);
              const flip = centerAngle > 90 && centerAngle < 270;
              return (
                <g key={i}>
                  <path d={slicePath(start, start + seg)} fill={COLORS[i % COLORS.length]} stroke="rgba(0,0,0,0.15)" strokeWidth={1} />
                  <g transform={`rotate(${centerAngle} ${lx} ${ly})${flip ? ` rotate(180 ${lx} ${ly})` : ""}`}>
                    <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle" className={w.label}>{trunc(label)}</text>
                  </g>
                </g>
              );
            })}
          </svg>
          {/* Clickable center hub — spins the wheel too. Sits outside the rotating
              <svg> so it stays upright. */}
          <button
            type="button"
            className={w.hub}
            onClick={spin}
            disabled={spinning || n < 2}
            aria-label="Spin the wheel"
          >
            {spinning ? "…" : "Spin"}
          </button>
        </div>
      </div>

      <p className={ui.resultBig} aria-live="polite">
        {spinning ? "Spinning…" : winner !== null ? labels[winner] : " "}
      </p>

      <div className={ui.controls}>
        <button className={`${ui.btn} ${ui.primary}`} onClick={spin} disabled={spinning || n < 2}>
          {spinning ? "…" : "Spin"}
        </button>
        <button className={ui.btn} onClick={tell} disabled={spinning || !last}>Tell the model</button>
      </div>

      <p className={ui.status}>{status}</p>

      <div className={ui.editor}>
        <div className={ui.chips}>
          {labels.map((label, i) => (
            <span key={i} className={ui.chip}>
              {label}
              <button className={ui.chipX} aria-label={`Remove ${label}`} onClick={() => remove(i)} disabled={spinning || n <= 2}>×</button>
            </span>
          ))}
        </div>
        <div className={ui.addRow}>
          <input
            className={ui.input}
            placeholder="Add a segment…"
            value={draft}
            maxLength={40}
            disabled={spinning || n >= MAX}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          />
          <button className={ui.btn} onClick={add} disabled={spinning || !draft.trim() || n >= MAX}>Add</button>
        </div>
      </div>
    </Shell>
  );
}

renderApp({ name: "Spin Wheel App", version: "1.0.0" }, WheelApp);
