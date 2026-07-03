/**
 * @file Decision die — a die whose faces are custom text (Yes / No / Maybe …).
 * Edit the faces to whatever you like, then roll.
 */
import { useEffect, useRef, useState } from "react";
import { pick } from "../lib/rng";
import {
  renderApp,
  Shell,
  tellModel,
  updateContext,
  useFlash,
  type AppProps,
} from "../lib/runtime";
import ui from "../lib/ui.module.css";
import { DecisionIcon } from "../lib/icons";
import dd from "./decision.module.css";

const DEFAULT_FACES = ["Yes", "No", "Maybe", "Definitely", "No way", "Ask again"];
const MAX = 12;

function DecisionDiceApp({ runtime }: AppProps) {
  const [faces, setFaces] = useState<string[]>(DEFAULT_FACES);
  const [result, setResult] = useState<string>(() => pick(DEFAULT_FACES));
  const [rolling, setRolling] = useState(false);
  const [draft, setDraft] = useState("");
  const [last, setLast] = useState<{ ctx: string; msg: string } | null>(null);
  const [status, flash] = useFlash();
  const timers = useRef<{ iv?: number; to?: number }>({});

  useEffect(() => {
    const sc = runtime.toolResult?.structuredContent as { faces?: unknown; result?: unknown } | undefined;
    const seedFaces = Array.isArray(sc?.faces) ? sc!.faces : Array.isArray(runtime.toolInput?.faces) ? runtime.toolInput!.faces : null;
    if (Array.isArray(seedFaces) && seedFaces.length) {
      const list = seedFaces.map(String).slice(0, MAX);
      setFaces(list);
      setResult(typeof sc?.result === "string" ? sc.result : list[0]);
    }
  }, [runtime.toolInput, runtime.toolResult]);

  useEffect(() => () => {
    if (timers.current.iv) clearInterval(timers.current.iv);
    if (timers.current.to) clearTimeout(timers.current.to);
  }, []);

  const roll = () => {
    if (rolling || faces.length < 1) return;
    setRolling(true);
    timers.current.iv = window.setInterval(() => setResult(pick(faces)), 90);
    timers.current.to = window.setTimeout(async () => {
      if (timers.current.iv) clearInterval(timers.current.iv);
      const res = pick(faces);
      setResult(res);
      setRolling(false);
      const ctx = `Rolled the decision die (faces: ${faces.join(", ")}); it landed on "${res}".`;
      setLast({ ctx, msg: `The decision die says: "${res}"` });
      void updateContext(runtime, ctx); // silent
    }, 700);
  };

  const tell = async () => {
    if (!last) return;
    const ok = await tellModel(runtime, last.msg, last.ctx);
    flash(runtime.standalone ? "Preview (not sent)" : ok ? "Sent to chat" : "Couldn't send");
  };

  const add = () => {
    const v = draft.trim();
    if (!v || rolling) return;
    setFaces((f) => (f.length >= MAX ? f : [...f, v]));
    setDraft("");
  };
  const remove = (i: number) => {
    if (rolling) return;
    setFaces((f) => (f.length > 1 ? f.filter((_, j) => j !== i) : f));
  };

  return (
    <Shell runtime={runtime}>
      <h1 className={ui.title}><DecisionIcon className={ui.titleIcon} />Decision Die</h1>
      <p className={ui.subtitle}>A die with your own faces</p>

      <div className={ui.stage}>
        <div className={`${dd.die} ${rolling ? dd.rolling : ""}`} aria-live="polite">
          <span className={dd.faceText}>{result}</span>
        </div>
      </div>

      <div className={ui.controls}>
        <button className={`${ui.btn} ${ui.primary}`} onClick={roll} disabled={rolling}>
          {rolling ? "Rolling…" : "Roll"}
        </button>
        <button className={ui.btn} onClick={tell} disabled={rolling || !last}>Tell the model</button>
      </div>

      <p className={ui.status}>{status}</p>

      <div className={ui.editor}>
        <div className={ui.chips}>
          {faces.map((face, i) => (
            <span key={i} className={ui.chip}>
              {face}
              <button className={ui.chipX} aria-label={`Remove ${face}`} onClick={() => remove(i)} disabled={rolling || faces.length <= 1}>×</button>
            </span>
          ))}
        </div>
        <div className={ui.addRow}>
          <input
            className={ui.input}
            placeholder="Add a face…"
            value={draft}
            maxLength={24}
            disabled={rolling || faces.length >= MAX}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          />
          <button className={ui.btn} onClick={add} disabled={rolling || !draft.trim() || faces.length >= MAX}>Add</button>
        </div>
      </div>
    </Shell>
  );
}

renderApp({ name: "Decision Dice App", version: "1.0.0" }, DecisionDiceApp);
