/**
 * @file A full 88-key piano you can play, plus a player for songs the model
 * writes.
 *
 * Three things share one instrument here, and the interesting part is that they
 * all schedule against the same clock.
 *
 * **Timing runs on the audio clock, never on a JS timer.** `setTimeout` and
 * even `requestAnimationFrame` drift by milliseconds and stall entirely in a
 * background tab, which is audible immediately as uneven rhythm. So the frame
 * loop does no playing: it only looks ahead, and anything due inside the next
 * `LOOKAHEAD` seconds is handed to Web Audio with an exact start time. Web Audio
 * then plays it sample-accurately whatever the main thread is doing. The same
 * scheduler drives the song and the metronome, which is why they stay locked
 * together.
 *
 * **Key highlighting is separate from key sounding.** A note scheduled 200ms
 * ahead must not light up 200ms early, so scheduled notes go into a list with
 * their start and end times and the render loop lights whichever are sounding
 * right now. Sound and picture agree because both read the same clock.
 *
 * The keys are white and purple rather than white and black. The layout is a
 * piano's, so the naturals stay white and read as naturals; only the
 * accidentals change, from black to a deep violet.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ControlBar,
  GameFrame,
  GameHeader,
  Notice,
  Segmented,
  StatusLine,
  clamp,
  seedArray,
  seedNumber,
  seedString,
  sv,
  useFrameLoop,
  useFullscreen,
  useSeed,
  useShare,
} from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import {
  HIGHEST,
  KEYS,
  KEY_LABEL,
  LOWEST,
  NATURAL_COUNT,
  QWERTY,
  freqOf,
  nameOf,
  parseNote,
  pitchClass,
} from "./notes";
import { Piano, VOICES, VOICE_NAMES, isVoice, type VoiceName } from "./synth";
import s from "./piano.module.css";

/** How far ahead of the playhead notes are handed to Web Audio. */
const LOOKAHEAD = 0.2;

/** One step of a song: a note, a chord, or a rest. */
interface Step {
  midis: number[];
  /** Seconds this step occupies, rest included. */
  seconds: number;
  /** Seconds the note actually sounds, which may be shorter than the step. */
  hold: number;
  velocity: number;
}

interface Scheduled {
  midi: number;
  start: number;
  end: number;
}

/** Segmented works on string unions, so the bar length is a string and is
 *  converted once, where it is counted. */
const BEATS_PER_BAR = ["2", "3", "4", "6"] as const;
type BarLength = (typeof BEATS_PER_BAR)[number];

/** A short built-in piece, so the keyboard is never a dead instrument. */
const DEMO = {
  title: "Ode to Joy",
  tempo: 108,
  notes: [
    "E4:1", "E4:1", "F4:1", "G4:1", "G4:1", "F4:1", "E4:1", "D4:1",
    "C4:1", "C4:1", "D4:1", "E4:1", "E4:1.5", "D4:0.5", "D4:2",
    "E4:1", "E4:1", "F4:1", "G4:1", "G4:1", "F4:1", "E4:1", "D4:1",
    "C4:1", "C4:1", "D4:1", "E4:1", "D4:1.5", "C4:0.5", "C4:2",
  ],
};

/**
 * Turn what the model sent into steps in seconds.
 *
 * Two note shapes are accepted because a model will produce both: an object
 * with fields, and the compact `"C4:1.5"` string, which is what it reaches for
 * when writing a long melody. Durations may be given in beats or in seconds,
 * since a request for "hold for 2 seconds" and one for "two beats" are both
 * reasonable and mean different things.
 */
function toSteps(raw: unknown[], tempo: number): Step[] {
  const beat = 60 / tempo;
  const out: Step[] = [];

  for (const item of raw) {
    let names: string[] = [];
    let beats: number | undefined;
    let seconds: number | undefined;
    let velocity = 0.85;
    let rest = false;

    if (typeof item === "string") {
      // "C4:1.5", "C4-E4-G4:2", "rest:1", or bare "C4".
      const [head, tail] = item.split(":");
      const dur = tail === undefined ? undefined : Number(tail);
      if (dur !== undefined && Number.isFinite(dur)) beats = dur;
      const token = head.trim();
      if (/^(rest|r|-|silence|pause)$/i.test(token)) rest = true;
      else names = token.split(/[-+,\s]+/).filter(Boolean);
    } else if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      rest = Boolean(o.rest) || o.note === null;
      const note = o.note ?? o.notes ?? o.chord;
      if (typeof note === "string") names = note.split(/[-+,\s]+/).filter(Boolean);
      else if (Array.isArray(note)) names = note.filter((n): n is string => typeof n === "string");
      if (typeof o.beats === "number") beats = o.beats;
      if (typeof o.duration === "number") beats = o.duration;
      if (typeof o.seconds === "number") seconds = o.seconds;
      if (typeof o.velocity === "number") velocity = clamp(o.velocity, 0.1, 1);
    } else {
      continue;
    }

    const span = seconds !== undefined ? clamp(seconds, 0.05, 12) : clamp((beats ?? 1) * beat, 0.05, 12);
    const midis = rest
      ? []
      : names.map(parseNote).filter((m): m is number => m !== null && m >= LOWEST && m <= HIGHEST);

    if (!rest && midis.length === 0) continue; // unparseable, drop it rather than stall
    // A hair of silence between steps keeps repeated notes from slurring.
    out.push({ midis, seconds: span, hold: Math.max(0.05, span * 0.92), velocity });
    if (out.length >= 600) break;
  }
  return out;
}

export default function MusicKeyboard({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  const [voice, setVoice] = useState<VoiceName>("bright");
  const [tempo, setTempo] = useState(108);
  const [metronome, setMetronome] = useState(false);
  const [barLength, setBarLength] = useState<BarLength>("4");
  const [playing, setPlaying] = useState(false);
  const [songTitle, setSongTitle] = useState<string | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [octave, setOctave] = useState(4);
  const [active, setActive] = useState<Set<number>>(() => new Set());
  const [labels, setLabels] = useState(true);
  const [ready, setReady] = useState(false);
  const [progress, setProgress] = useState(0);

  const piano = useRef(new Piano());
  const scrollRef = useRef<HTMLDivElement>(null);

  /** Scheduler state, all on the audio clock. */
  const sched = useRef({
    index: 0,
    nextAt: 0,
    beatAt: 0,
    beatIndex: 0,
    queued: [] as Scheduled[],
  });

  const held = useRef<Set<number>>(new Set());

  useEffect(() => {
    const p = piano.current;
    return () => p.dispose();
  }, []);

  useEffect(() => {
    piano.current.setVoice(voice);
  }, [voice]);

  /** Any gesture is the moment the browser lets us have an audio context. */
  const wake = useCallback(async () => {
    await piano.current.unlock();
    setReady(piano.current.ready);
  }, []);

  /* ---- What the model sent ---- */
  const sig = useMemo(() => JSON.stringify(seed), [seed]);
  const lastSig = useRef("");
  useEffect(() => {
    if (sig === lastSig.current) return;
    lastSig.current = sig;

    const v = seedString(seed, "voice");
    if (v && isVoice(v)) setVoice(v);

    const bpm = seedNumber(seed, "tempo", 0, 30, 260);
    const notes = seedArray<unknown>(seed, "notes");
    const title = seedString(seed, "title");

    if (notes.length === 0) return;
    const useTempo = bpm || 108;
    const parsed = toSteps(notes, useTempo);
    if (parsed.length === 0) return;
    setTempo(useTempo);
    setSteps(parsed);
    setSongTitle(title || "A song from the model");
  }, [sig, seed]);

  /* ---- Free play ---- */
  const press = useCallback(
    (midi: number) => {
      if (held.current.has(midi)) return;
      held.current.add(midi);
      void wake().then(() => piano.current.noteOn(midi, freqOf(midi), undefined, undefined, 0.9));
      setActive((prev) => new Set(prev).add(midi));
    },
    [wake],
  );

  const lift = useCallback((midi: number) => {
    if (!held.current.delete(midi)) return;
    piano.current.noteOff(midi);
    setActive((prev) => {
      const next = new Set(prev);
      next.delete(midi);
      return next;
    });
  }, []);

  /**
   * QWERTY. Needs both keydown and keyup, which the shared `useKeys` does not
   * offer because no other game has a note-off.
   */
  useEffect(() => {
    const base = (octave + 1) * 12; // C of the mapped octave
    const isField = (t: EventTarget | null) => {
      const tag = (t as HTMLElement | null)?.tagName;
      return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
    };

    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isField(e.target)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setOctave((o) => clamp(o - 1, 0, 7));
        return;
      }
      if (e.key === "ArrowRight") {
        e.preventDefault();
        setOctave((o) => clamp(o + 1, 0, 7));
        return;
      }
      const offset = QWERTY[e.key.toLowerCase()];
      if (offset === undefined) return;
      e.preventDefault();
      if (e.repeat) return;
      const midi = base + offset;
      if (midi >= LOWEST && midi <= HIGHEST) press(midi);
    };

    const up = (e: KeyboardEvent) => {
      const offset = QWERTY[e.key.toLowerCase()];
      if (offset === undefined) return;
      const midi = base + offset;
      if (midi >= LOWEST && midi <= HIGHEST) lift(midi);
    };

    // Losing focus mid-chord would otherwise leave notes ringing forever.
    const panic = () => {
      for (const m of [...held.current]) lift(m);
    };

    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", panic);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", panic);
      panic();
    };
  }, [octave, press, lift]);

  /* ---- Transport ---- */
  const stop = useCallback(() => {
    setPlaying(false);
    piano.current.allOff();
    sched.current.index = 0;
    sched.current.queued = [];
    setProgress(0);
    setActive(new Set(held.current));
  }, []);

  const startSong = useCallback(async () => {
    if (steps.length === 0) return;
    await wake();
    const now = piano.current.now();
    sched.current.index = 0;
    sched.current.nextAt = now + 0.12;
    sched.current.queued = [];
    setProgress(0);
    setPlaying(true);
  }, [steps.length, wake]);

  const toggleMetronome = useCallback(async () => {
    await wake();
    setMetronome((on) => {
      if (!on) {
        sched.current.beatAt = piano.current.now() + 0.1;
        sched.current.beatIndex = 0;
      }
      return !on;
    });
  }, [wake]);

  /**
   * The one loop. It never plays anything itself: it hands Web Audio whatever
   * falls inside the lookahead window, then updates which keys are lit from the
   * audio clock so the picture matches the sound.
   */
  useFrameLoop(playing || metronome || active.size > 0, () => {
    const p = piano.current;
    if (!p.ready) return;
    const now = p.now();
    const horizon = now + LOOKAHEAD;
    const st = sched.current;

    // Song.
    if (playing) {
      while (st.index < steps.length && st.nextAt < horizon) {
        const step = steps[st.index];
        for (const midi of step.midis) {
          p.noteOn(midi, freqOf(midi), st.nextAt, step.hold, step.velocity);
          st.queued.push({ midi, start: st.nextAt, end: st.nextAt + step.hold });
        }
        st.nextAt += step.seconds;
        st.index++;
      }
      if (st.index >= steps.length && st.nextAt <= now) {
        setPlaying(false);
        setProgress(1);
      } else {
        setProgress(steps.length ? Math.min(1, st.index / steps.length) : 0);
      }
    }

    // Metronome, on the same clock, so it cannot drift against the song.
    if (metronome) {
      const spb = 60 / tempo;
      while (st.beatAt < horizon) {
        p.click(st.beatAt, st.beatIndex % Number(barLength) === 0);
        st.beatAt += spb;
        st.beatIndex++;
      }
    }

    // Light whatever is sounding now, plus anything a finger is holding.
    st.queued = st.queued.filter((q) => q.end > now - 0.05);
    const lit = new Set(held.current);
    for (const q of st.queued) if (q.start <= now && q.end > now) lit.add(q.midi);
    setActive((prev) => {
      if (prev.size === lit.size && [...lit].every((m) => prev.has(m))) return prev;
      return lit;
    });
  });

  /* ---- Pointer play ---- */
  const onPointerDown = useCallback(
    (midi: number, e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      // Release capture so sliding across keys plays them, as a piano does.
      e.currentTarget.releasePointerCapture?.(e.pointerId);
      press(midi);
    },
    [press],
  );

  useEffect(() => {
    const up = () => {
      for (const m of [...held.current]) lift(m);
    };
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, [lift]);

  /** Scroll the mapped octave into view when it changes. */
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const target = KEYS.findIndex((k) => !k.accidental && k.midi >= (octave + 1) * 12);
    if (target < 0) return;
    const naturalsBefore = KEYS.slice(0, target).filter((k) => !k.accidental).length;
    const per = box.scrollWidth / NATURAL_COUNT;
    box.scrollTo({ left: Math.max(0, naturalsBefore * per - box.clientWidth * 0.15), behavior: "smooth" });
  }, [octave]);

  const askForSong = useCallback(() => {
    void share(
      "Write me a short song for the piano and send it with the music-keyboard tool.",
      "The player asked for a song from the piano app.",
    );
  }, [share]);

  const loadDemo = useCallback(() => {
    setSteps(toSteps(DEMO.notes, DEMO.tempo));
    setTempo(DEMO.tempo);
    setSongTitle(DEMO.title);
  }, []);

  const mappedLow = (octave + 1) * 12;
  const naturals = KEYS.filter((k) => !k.accidental);

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={s.root}>
      <GameHeader
        title="Music Keyboard"
        stats={[
          { label: "Voice", value: VOICES[voice].label },
          { label: "Tempo", value: `${tempo}` },
          { label: "Octave", value: `C${octave}` },
        ]}
        hint={songTitle ?? VOICES[voice].blurb}
      />

      {/* The keyboard scrolls; 88 keys never fit a host panel. */}
      <div className={s.boardWrap}>
        <div className={s.board} ref={scrollRef}>
          <div className={s.keys} style={sv({ "--naturals": NATURAL_COUNT })}>
            {naturals.map((k) => (
              <button
                key={k.midi}
                type="button"
                className={`${s.natural} ${active.has(k.midi) ? s.on : ""} ${
                  k.midi >= mappedLow && k.midi < mappedLow + 29 ? s.mapped : ""
                }`}
                onPointerDown={(e) => onPointerDown(k.midi, e)}
                onPointerEnter={(e) => {
                  if (e.buttons > 0) press(k.midi);
                }}
                onPointerLeave={() => lift(k.midi)}
                aria-label={nameOf(k.midi)}
              >
                <span className={s.keyName}>
                  {pitchClass(k.midi) === 0 ? nameOf(k.midi) : ""}
                </span>
                {labels && KEY_LABEL[k.midi - mappedLow] && (
                  <span className={s.qwerty}>{KEY_LABEL[k.midi - mappedLow]}</span>
                )}
              </button>
            ))}

            {KEYS.filter((k) => k.accidental).map((k) => (
              <button
                key={k.midi}
                type="button"
                className={`${s.accidental} ${active.has(k.midi) ? s.on : ""} ${
                  k.midi >= mappedLow && k.midi < mappedLow + 29 ? s.mapped : ""
                }`}
                style={sv({ "--n": k.naturalIndex })}
                onPointerDown={(e) => onPointerDown(k.midi, e)}
                onPointerEnter={(e) => {
                  if (e.buttons > 0) press(k.midi);
                }}
                onPointerLeave={() => lift(k.midi)}
                aria-label={nameOf(k.midi)}
              >
                {labels && KEY_LABEL[k.midi - mappedLow] && (
                  <span className={s.qwertyDark}>{KEY_LABEL[k.midi - mappedLow]}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>

      {steps.length > 0 && (
        <div className={s.transport}>
          <span className={s.songName}>{songTitle}</span>
          <div className={s.progress} role="progressbar" aria-valuenow={Math.round(progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <span className={s.progressFill} style={{ width: `${progress * 100}%` }} />
          </div>
          <button className={`${ui.btn} ${ui.primary}`} onClick={playing ? stop : startSong}>
            {playing ? "Stop" : "Play"}
          </button>
        </div>
      )}

      <ControlBar>
        <Segmented<VoiceName>
          label="Voice"
          options={VOICE_NAMES.map((v) => ({ value: v, label: VOICES[v].label }))}
          value={voice}
          onChange={(v) => {
            setVoice(v);
            void wake();
          }}
        />
      </ControlBar>

      <ControlBar>
        <button
          className={`${ui.btn} ${metronome ? ui.primary : ""}`}
          aria-pressed={metronome}
          onClick={toggleMetronome}
        >
          Metronome
        </button>
        <div className={s.stepper}>
          <button className={`${ui.btn} ${ui.icon}`} onClick={() => setTempo((t) => clamp(t - 4, 30, 260))} aria-label="Slower">
            &minus;
          </button>
          <span className={s.bpm}>{tempo} bpm</span>
          <button className={`${ui.btn} ${ui.icon}`} onClick={() => setTempo((t) => clamp(t + 4, 30, 260))} aria-label="Faster">
            +
          </button>
        </div>
        <Segmented<BarLength>
          label="Beats per bar"
          options={BEATS_PER_BAR.map((b) => ({ value: b, label: `${b}/4` }))}
          value={barLength}
          onChange={setBarLength}
        />
      </ControlBar>

      <ControlBar>
        <button className={`${ui.btn} ${ui.icon}`} onClick={() => setOctave((o) => clamp(o - 1, 0, 7))} aria-label="Octave down">
          &larr;
        </button>
        <span className={s.octaveLabel}>Keys play from C{octave}</span>
        <button className={`${ui.btn} ${ui.icon}`} onClick={() => setOctave((o) => clamp(o + 1, 0, 7))} aria-label="Octave up">
          &rarr;
        </button>
        <button className={`${ui.btn} ${labels ? ui.primary : ""}`} aria-pressed={labels} onClick={() => setLabels((v) => !v)}>
          Key hints
        </button>
      </ControlBar>

      <ControlBar>
        <button className={ui.btn} onClick={askForSong}>
          Ask for a song
        </button>
        <button className={ui.btn} onClick={loadDemo}>
          Load a demo
        </button>
        <button className={ui.btn} onClick={stop} disabled={!playing}>
          Panic
        </button>
      </ControlBar>

      {!ready && <Notice>Touch a key or press one to start the audio. Browsers require a gesture first.</Notice>}
      {ready && (
        <Notice>
          Z row and Q row are two octaves of naturals, the keys between them are the sharps. Left and right
          arrows shift octave.
        </Notice>
      )}

      <StatusLine>{shareStatus}</StatusLine>
    </GameFrame>
  );
}
