/**
 * @file Interactive color picker app. HSVA is the source of truth; HEX/RGB/HSL
 * are derived each render and parsed back into HSVA only on explicit input.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  clamp,
  colorStrings,
  hsvaFromRgb,
  parseHex,
  type HSVA,
} from "../lib/color";
import {
  renderApp,
  Shell,
  tellModel,
  useFlash,
  type AppProps,
  type Runtime,
} from "../lib/runtime";
import styles from "./picker.module.css";

const DEFAULT: HSVA = { h: 217, s: 0.83, v: 0.92, a: 1 };

const PRESETS = [
  "#000000", "#434343", "#666666", "#999999", "#b7b7b7",
  "#cccccc", "#d9d9d9", "#efefef", "#f3f3f3", "#ffffff",
  "#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00",
  "#00ffff", "#4a86e8", "#0000ff", "#9900ff", "#ff00ff",
  "#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3",
  "#d0e0e3", "#c9daf8", "#cfe2f3", "#d9d2e9", "#ead1dc",
];

interface EyeDropperCtor {
  new (): { open(): Promise<{ sRGBHex: string }> };
}
const EyeDropper = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper;

function seedFromRuntime(runtime: Runtime): string | undefined {
  const fromResult = (runtime.toolResult?.structuredContent as { color?: string } | undefined)?.color;
  const fromInput = runtime.toolInput?.initialColor as string | undefined;
  return fromResult ?? fromInput;
}

function useDrag(ref: RefObject<HTMLElement | null>, onMove: (nx: number, ny: number) => void) {
  const dragging = useRef(false);
  const emit = useCallback((e: { clientX: number; clientY: number }) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    onMove(
      clamp((e.clientX - rect.left) / rect.width, 0, 1),
      clamp((e.clientY - rect.top) / rect.height, 0, 1),
    );
  }, [ref, onMove]);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      dragging.current = true;
      ref.current?.setPointerCapture(e.pointerId);
      emit(e);
    },
    onPointerMove: (e: React.PointerEvent) => { if (dragging.current) emit(e); },
    onPointerUp: (e: React.PointerEvent) => {
      dragging.current = false;
      ref.current?.releasePointerCapture(e.pointerId);
    },
  };
}

function ColorPickerApp({ runtime }: AppProps) {
  const seedHex = seedFromRuntime(runtime);

  const [hsva, setHsva] = useState<HSVA>(() => {
    const p = seedHex ? parseHex(seedHex) : null;
    return p ? hsvaFromRgb(p.rgb, p.a, DEFAULT.h) : DEFAULT;
  });

  useEffect(() => {
    if (!seedHex) return;
    const p = parseHex(seedHex);
    if (p) setHsva((prev) => hsvaFromRgb(p.rgb, p.a, prev.h));
  }, [seedHex]);

  const { rgb, hex, rgbStr, hslStr } = colorStrings(hsva);

  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const [rgbDraft, setRgbDraft] = useState<Record<"r" | "g" | "b", string> | null>(null);

  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);
  const alphaRef = useRef<HTMLDivElement>(null);
  const svDrag = useDrag(svRef, useCallback((nx, ny) => setHsva((s) => ({ ...s, s: nx, v: 1 - ny })), []));
  const hueDrag = useDrag(hueRef, useCallback((nx) => setHsva((s) => ({ ...s, h: nx * 360 })), []));
  const alphaDrag = useDrag(alphaRef, useCallback((nx) => setHsva((s) => ({ ...s, a: nx })), []));

  const onSvKey = useCallback((e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    setHsva((s) => {
      if (e.key === "ArrowRight") return { ...s, s: clamp(s.s + step, 0, 1) };
      if (e.key === "ArrowLeft") return { ...s, s: clamp(s.s - step, 0, 1) };
      if (e.key === "ArrowUp") return { ...s, v: clamp(s.v + step, 0, 1) };
      if (e.key === "ArrowDown") return { ...s, v: clamp(s.v - step, 0, 1) };
      return s;
    });
    if (["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown"].includes(e.key)) e.preventDefault();
  }, []);

  const onHexChange = (val: string) => {
    setHexDraft(val);
    const p = parseHex(val);
    if (p) setHsva((s) => hsvaFromRgb(p.rgb, p.a, s.h));
  };
  const onRgbChange = (key: "r" | "g" | "b", val: string) => {
    const base = rgbDraft ?? { r: String(rgb.r), g: String(rgb.g), b: String(rgb.b) };
    const next = { ...base, [key]: val };
    setRgbDraft(next);
    const nums = {
      r: clamp(parseInt(next.r, 10) || 0, 0, 255),
      g: clamp(parseInt(next.g, 10) || 0, 0, 255),
      b: clamp(parseInt(next.b, 10) || 0, 0, 255),
    };
    setHsva((s) => hsvaFromRgb(nums, s.a, s.h));
  };

  const [status, flash] = useFlash();
  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    flash(`Copied ${text}`);
  }, [flash]);

  const pickWithEyeDropper = useCallback(async () => {
    if (!EyeDropper) return;
    try {
      const { sRGBHex } = await new EyeDropper().open();
      const p = parseHex(sRGBHex);
      if (p) setHsva((s) => hsvaFromRgb(p.rgb, 1, s.h));
    } catch { /* cancelled */ }
  }, []);

  const [sending, setSending] = useState(false);
  const useColor = useCallback(async () => {
    setSending(true);
    const ok = await tellModel(
      runtime,
      `I picked the color ${hex}.`,
      `The user selected a color in the color picker:\n- hex: ${hex}\n- rgb: ${rgbStr}\n- hsl: ${hslStr}`,
    );
    setSending(false);
    flash(runtime.standalone ? `Preview: ${hex}` : ok ? `Sent ${hex} to the chat` : "Could not send color");
  }, [runtime, hex, rgbStr, hslStr, flash]);

  const solid = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;

  return (
    <Shell runtime={runtime}>
      <section className={styles.picker}>
        <div
          ref={svRef}
          className={styles.svArea}
          style={{ ["--hue" as string]: hsva.h }}
          role="slider"
          aria-label="Saturation and brightness"
          aria-valuetext={hex}
          tabIndex={0}
          onKeyDown={onSvKey}
          {...svDrag}
        >
          <div className={styles.svWhite} />
          <div className={styles.svBlack} />
          <div className={styles.svHandle} style={{ left: `${hsva.s * 100}%`, top: `${(1 - hsva.v) * 100}%` }} />
        </div>

        <div className={styles.controls}>
          <div
            className={styles.preview}
            title={hex}
            style={{ ["--preview-color" as string]: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${hsva.a})` }}
          />
          <div className={styles.sliderStack}>
            <div ref={hueRef} className={`${styles.track} ${styles.hueTrack}`} role="slider" aria-label="Hue" aria-valuenow={Math.round(hsva.h)} aria-valuemax={360} tabIndex={0} {...hueDrag}>
              <div className={styles.trackHandle} style={{ left: `${(hsva.h / 360) * 100}%` }} />
            </div>
            <div ref={alphaRef} className={`${styles.track} ${styles.alphaTrack}`} role="slider" aria-label="Opacity" aria-valuenow={Math.round(hsva.a * 100)} tabIndex={0} {...alphaDrag}>
              <div className={styles.alphaFill} style={{ ["--alpha-color" as string]: `linear-gradient(to right, transparent, ${solid})` }} />
              <div className={styles.trackHandle} style={{ left: `${hsva.a * 100}%` }} />
            </div>
          </div>
        </div>
      </section>

      <section className={styles.readouts}>
        <div className={styles.field}>
          <label htmlFor="hex-input">HEX</label>
          <div className={styles.inputRow}>
            <input id="hex-input" type="text" spellCheck={false} autoComplete="off" value={hexDraft ?? hex} onChange={(e) => onHexChange(e.target.value)} onBlur={() => setHexDraft(null)} />
            <button className={styles.copyBtn} onClick={() => copy(hex)}>Copy</button>
          </div>
        </div>
        <div className={styles.field}>
          <label>RGB</label>
          <div className={`${styles.inputRow} ${styles.rgbRow}`}>
            {(["r", "g", "b"] as const).map((k) => (
              <input key={k} type="number" min={0} max={255} aria-label={{ r: "Red", g: "Green", b: "Blue" }[k]} value={rgbDraft ? rgbDraft[k] : String(rgb[k])} onChange={(e) => onRgbChange(k, e.target.value)} onBlur={() => setRgbDraft(null)} />
            ))}
            <button className={styles.copyBtn} onClick={() => copy(rgbStr)}>Copy</button>
          </div>
        </div>
        <div className={styles.field}>
          <label htmlFor="hsl-input">HSL</label>
          <div className={styles.inputRow}>
            <input id="hsl-input" type="text" readOnly value={hslStr} />
            <button className={styles.copyBtn} onClick={() => copy(hslStr)}>Copy</button>
          </div>
        </div>
      </section>

      <section className={styles.swatches} aria-label="Preset colors">
        {PRESETS.map((c) => (
          <button
            key={c}
            className={styles.swatch}
            style={{ backgroundColor: c }}
            title={c}
            aria-label={c}
            onClick={() => { const p = parseHex(c); if (p) setHsva((s) => hsvaFromRgb(p.rgb, 1, s.h)); }}
          />
        ))}
      </section>

      <section className={styles.actions}>
        {EyeDropper && <button className={styles.ghostBtn} onClick={pickWithEyeDropper}>Pick from screen</button>}
        <button className={styles.primaryBtn} onClick={useColor} disabled={sending}>{sending ? "Sending…" : "Use this color"}</button>
      </section>

      <p className={styles.status} role="status" aria-live="polite">{status}</p>
    </Shell>
  );
}

renderApp({ name: "Color Picker App", version: "1.0.0" }, ColorPickerApp);
