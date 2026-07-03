/**
 * @file Multi-word sequential Wordle with variable-length words.
 *
 * Target words are resolved in priority order:
 *   1. Model-provided words — `toolResult.structuredContent.words` (or
 *      `toolInput.words`): sanitized to letters-only, length 3–10, deduped,
 *      capped at 40, with their varying lengths preserved.
 *   2. Fallback — generated CLIENT-SIDE from a bundled dictionary using
 *      `count` (5–40, default 5), so standalone preview always works.
 *
 * The answers never leave the app and are never sent back to the model. Play
 * each word on a standard 6-guess Wordle board; solve or exhaust it to advance
 * to the next until every word is done.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  renderApp,
  tellModel,
  updateContext,
  useFlash,
  useFullscreen,
  type AppProps,
} from "../lib/runtime";
import ui from "../lib/ui.module.css";
import { WordleIcon } from "../lib/icons";
import s from "./wordle.module.css";
import { generateTargets } from "./words";

const MAX_GUESSES = 6;
const MIN_COUNT = 5;
const MAX_COUNT = 40;
const MIN_LEN = 3;
const MAX_LEN = 10;

type Mark = "correct" | "present" | "absent";

interface WordState {
  /** Target word, UPPERCASE. Never sent to the model. */
  word: string;
  /** Submitted guesses, UPPERCASE, each the same length as `word`. */
  guesses: string[];
  solved: boolean;
}

const KEY_ROWS = ["QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"] as const;

/** Pre-computed CSS-only confetti pieces shown on a perfect finish. */
const CONFETTI_COLORS = ["#22c55e", "#eab308", "var(--color-accent)", "#ef4444", "#38bdf8"];
const CONFETTI = Array.from({ length: 18 }, (_, i) => ({
  left: (i * 100) / 18 + (i % 3) * 3,
  delay: (i % 9) * 0.16,
  duration: 2.1 + (i % 5) * 0.4,
  color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
}));

/** Standard Wordle scoring with correct duplicate-letter handling. */
function scoreGuess(guess: string, target: string): Mark[] {
  const n = target.length;
  const marks: Mark[] = new Array(n).fill("absent");
  const remaining: Record<string, number> = {};
  for (const ch of target) remaining[ch] = (remaining[ch] ?? 0) + 1;

  // Pass 1 — exact position matches consume a letter first.
  for (let i = 0; i < n; i++) {
    if (guess[i] === target[i]) {
      marks[i] = "correct";
      remaining[guess[i]]--;
    }
  }
  // Pass 2 — present-elsewhere only while copies remain.
  for (let i = 0; i < n; i++) {
    if (marks[i] === "correct") continue;
    const ch = guess[i];
    if (remaining[ch] > 0) {
      marks[i] = "present";
      remaining[ch]--;
    }
  }
  return marks;
}

const isDone = (w: WordState) => w.solved || w.guesses.length >= MAX_GUESSES;

/**
 * Sanitize a model-provided word list: letters only, UPPERCASE, length 3–10,
 * deduped, and capped at MAX_COUNT. Varying lengths are preserved. Anything
 * that isn't a usable word is dropped. Returns `[]` when nothing is provided.
 */
function sanitizeWords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const clean = item.toLowerCase().replace(/[^a-z]/g, "");
    if (clean.length < MIN_LEN || clean.length > MAX_LEN) continue;
    if (seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean.toUpperCase());
    if (out.length >= MAX_COUNT) break;
  }
  return out;
}

function makeWords(targets: string[]): WordState[] {
  return targets.map((word) => ({ word, guesses: [], solved: false }));
}

function WordleApp({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [status, flash] = useFlash();

  // Priority 1: words supplied by the model (tool result, else tool input).
  const providedTargets = useMemo(() => {
    const fromResult = sanitizeWords(
      (runtime.toolResult?.structuredContent as { words?: unknown } | undefined)?.words,
    );
    return fromResult.length ? fromResult : sanitizeWords(runtime.toolInput?.words);
  }, [runtime.toolResult, runtime.toolInput]);

  // Priority 2 (fallback): a count for the bundled dictionary — clamp to
  // [5, 40], default 5 (also the standalone-preview default).
  const count = useMemo(() => {
    const raw = Number(runtime.toolInput?.count);
    if (!Number.isFinite(raw)) return MIN_COUNT;
    return Math.min(MAX_COUNT, Math.max(MIN_COUNT, Math.round(raw)));
  }, [runtime.toolInput]);

  // Build the actual target set: provided words when present, else generate.
  const buildTargets = useCallback(
    () => (providedTargets.length ? providedTargets : generateTargets(count)),
    [providedTargets, count],
  );

  // A signature of the *inputs* (not the randomized dictionary output) so we
  // re-seed only when the request genuinely changes — including when the host
  // delivers `toolResult`/`toolInput` after mount. Stays idempotent under
  // StrictMode's double-invoked effects.
  const seedKey = providedTargets.length ? `w:${providedTargets.join(",")}` : `c:${count}`;

  const [words, setWords] = useState<WordState[]>(() => makeWords(buildTargets()));
  const [current, setCurrent] = useState("");
  const seededKey = useRef<string>(seedKey);

  useEffect(() => {
    if (seededKey.current === seedKey) return;
    seededKey.current = seedKey;
    setWords(makeWords(buildTargets()));
    setCurrent("");
  }, [seedKey, buildTargets]);

  const total = words.length;
  const activeIndex = useMemo(() => words.findIndex((w) => !isDone(w)), [words]);
  const active = activeIndex >= 0 ? words[activeIndex] : null;
  const activeLen = active ? active.word.length : 0;
  const solvedCount = useMemo(() => words.filter((w) => w.solved).length, [words]);
  const allDone = total > 0 && activeIndex < 0;

  // Row shake for an invalid/too-short Enter. Re-armed via rAF so consecutive
  // invalid presses replay the animation.
  const [shaking, setShaking] = useState(false);
  const shakeRaf = useRef<number | undefined>(undefined);
  const triggerShake = useCallback(() => {
    setShaking(false);
    if (shakeRaf.current) cancelAnimationFrame(shakeRaf.current);
    shakeRaf.current = requestAnimationFrame(() => setShaking(true));
  }, []);
  useEffect(() => () => { if (shakeRaf.current) cancelAnimationFrame(shakeRaf.current); }, []);

  // ---- Input handlers -----------------------------------------------------
  const onLetter = useCallback((ch: string) => {
    if (activeIndex < 0) return;
    setCurrent((c) => (c.length >= activeLen ? c : c + ch));
  }, [activeIndex, activeLen]);

  const onBack = useCallback(() => setCurrent((c) => c.slice(0, -1)), []);

  const onEnter = useCallback(() => {
    if (activeIndex < 0) return;
    if (current.length !== activeLen) {
      triggerShake();
      flash("Not enough letters");
      return;
    }
    const guess = current.toUpperCase();
    setWords((ws) =>
      ws.map((w, i) =>
        i === activeIndex
          ? { ...w, guesses: [...w.guesses, guess], solved: guess === w.word }
          : w,
      ),
    );
    setCurrent("");
  }, [activeIndex, activeLen, current, flash, triggerShake]);

  // Physical keyboard.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (activeIndex < 0) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter") {
        e.preventDefault();
        onEnter();
      } else if (e.key === "Backspace") {
        e.preventDefault();
        onBack();
      } else if (e.key.length === 1 && /[a-zA-Z]/.test(e.key)) {
        e.preventDefault();
        onLetter(e.key.toUpperCase());
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIndex, onEnter, onBack, onLetter]);

  // On-screen key coloring from the ACTIVE word's guesses (best-known state).
  const keyStates = useMemo(() => {
    const map: Record<string, Mark> = {};
    if (!active) return map;
    const rank: Record<Mark, number> = { absent: 0, present: 1, correct: 2 };
    for (const g of active.guesses) {
      const marks = scoreGuess(g, active.word);
      for (let i = 0; i < g.length; i++) {
        const ch = g[i];
        const st = marks[i];
        if (!map[ch] || rank[st] > rank[map[ch]]) map[ch] = st;
      }
    }
    return map;
  }, [active]);

  // Silent, answer-free completion note for the model (no model turn).
  const reported = useRef(false);
  useEffect(() => {
    if (allDone && !reported.current) {
      reported.current = true;
      void updateContext(runtime, `Wordle finished: solved ${solvedCount} of ${total} words.`);
    }
    if (!allDone) reported.current = false;
  }, [allDone, solvedCount, total, runtime]);

  const newGame = useCallback(() => {
    setWords(makeWords(buildTargets()));
    setCurrent("");
  }, [buildTargets]);

  const tell = useCallback(async () => {
    const msg = `I finished the Wordle challenge and solved ${solvedCount} of ${total} words!`;
    const ok = await tellModel(runtime, msg, `Wordle result: solved ${solvedCount}/${total}.`);
    flash(runtime.standalone ? "Preview (not sent)" : ok ? "Sent to chat" : "Couldn't send");
  }, [runtime, solvedCount, total, flash]);

  // ---- Render -------------------------------------------------------------
  const insets = runtime.hostContext?.safeAreaInsets;

  return (
    <div
      ref={rootRef}
      className={`${s.root} ${isFull ? s.full : ""}`}
      style={{
        paddingTop: insets?.top,
        paddingRight: insets?.right,
        paddingBottom: insets?.bottom,
        paddingLeft: insets?.left,
      }}
    >
      {allDone && solvedCount === total && (
        <div className={s.confetti} aria-hidden="true">
          {CONFETTI.map((p, i) => (
            <span
              key={i}
              className={s.confettiPiece}
              style={{
                left: `${p.left}%`,
                background: p.color,
                animationDelay: `${p.delay}s`,
                animationDuration: `${p.duration}s`,
              }}
            />
          ))}
        </div>
      )}

      <header className={s.header}>
        <h1 className={ui.title}><WordleIcon className={ui.titleIcon} />Wordle</h1>
        <p className={ui.subtitle}>
          {allDone
            ? `All done — solved ${solvedCount} of ${total}`
            : `Word ${Math.max(activeIndex, 0) + 1} of ${total} · solved ${solvedCount}`}
        </p>
      </header>

      {/* Overview: every target as a variable-width row of tiles. */}
      <div className={s.overview} aria-label="All words">
        {words.map((w, i) => {
          const done = isDone(w);
          const activeChip = i === activeIndex;
          const reveal = w.solved || (done && !w.solved);
          return (
            <div
              key={i}
              className={`${s.chip} ${activeChip ? s.activeChip : ""}`}
              title={`Word ${i + 1} · ${w.word.length} letters`}
            >
              {Array.from({ length: w.word.length }).map((_, j) => (
                <span
                  key={j}
                  className={[
                    s.miniTile,
                    w.solved ? s.solved : done ? s.missed : activeChip ? s.activeEmpty : "",
                  ].filter(Boolean).join(" ")}
                >
                  {reveal ? w.word[j] : ""}
                </span>
              ))}
            </div>
          );
        })}
      </div>

      {active && (
        <>
          <div
            className={s.board}
            aria-label={`Guess a ${activeLen}-letter word`}
            style={{ ["--len" as string]: activeLen }}
          >
            {Array.from({ length: MAX_GUESSES }).map((_, r) => {
              const submitted = r < active.guesses.length;
              const isCurrentRow = !submitted && r === active.guesses.length;
              const marks = submitted ? scoreGuess(active.guesses[r], active.word) : null;
              const rowText = submitted
                ? active.guesses[r]
                : isCurrentRow
                  ? current
                  : "";
              return (
                <div
                  className={[s.row, isCurrentRow && shaking ? s.shake : ""].filter(Boolean).join(" ")}
                  key={r}
                  onAnimationEnd={
                    isCurrentRow
                      ? (e) => { if (e.target === e.currentTarget) setShaking(false); }
                      : undefined
                  }
                >
                  {Array.from({ length: activeLen }).map((_, cIdx) => {
                    const ch = rowText[cIdx] ?? "";
                    return (
                      <div
                        key={cIdx}
                        className={[
                          s.tile,
                          submitted && marks ? s[marks[cIdx]] : ch ? s.filled : "",
                        ].filter(Boolean).join(" ")}
                        style={{ ["--col" as string]: cIdx }}
                      >
                        {ch}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* On-screen QWERTY keyboard. */}
          <div className={s.keyboard} aria-label="Keyboard">
            {KEY_ROWS.map((rowKeys, ri) => (
              <div className={s.krow} key={ri}>
                {ri === KEY_ROWS.length - 1 && (
                  <button
                    className={`${s.key} ${s.wide}`}
                    onClick={onEnter}
                    aria-label="Enter"
                  >
                    Enter
                  </button>
                )}
                {rowKeys.split("").map((ch) => (
                  <button
                    key={ch}
                    className={[s.key, keyStates[ch] ? s[keyStates[ch]] : ""].filter(Boolean).join(" ")}
                    onClick={() => onLetter(ch)}
                    aria-label={ch}
                  >
                    {ch}
                  </button>
                ))}
                {ri === KEY_ROWS.length - 1 && (
                  <button
                    className={`${s.key} ${s.wide}`}
                    onClick={onBack}
                    aria-label="Backspace"
                  >
                    ⌫
                  </button>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {allDone && (
        <div className={s.summary}>
          <span
            className={[
              ui.banner,
              solvedCount === total ? ui.win : ui.tie,
              s.summaryBanner,
              solvedCount === total ? s.perfect : "",
            ].filter(Boolean).join(" ")}
          >
            {solvedCount === total ? "Perfect!" : "Game over"} — solved {solvedCount} / {total}
          </span>
        </div>
      )}

      <div className={ui.controls}>
        <button className={`${ui.btn} ${ui.primary}`} onClick={newGame}>New game</button>
        <button className={ui.btn} onClick={tell} disabled={!allDone}>Tell the model</button>
        <button className={ui.btn} onClick={toggleFull}>{isFull ? "Exit fullscreen" : "Fullscreen"}</button>
      </div>

      <p className={ui.status} role="status" aria-live="polite">{status}</p>
    </div>
  );
}

renderApp({ name: "Wordle App", version: "1.0.0" }, WordleApp);
