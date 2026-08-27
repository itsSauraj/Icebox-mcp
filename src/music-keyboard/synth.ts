/**
 * @file The sound. Web Audio only, no samples anywhere.
 *
 * That is not a shortcut, it is the constraint: these bundles are single
 * self-contained HTML files with no network access, so a sampled piano is not
 * available at any price. Everything here is synthesised.
 *
 * Each voice is a `PeriodicWave` built from a harmonic amplitude table, which
 * is what gives one oscillator a specific timbre instead of needing a stack of
 * them per note. On top of that, two envelopes do most of the perceptual work:
 *
 *  - The gain envelope is struck-string shaped, not organ shaped: fast attack,
 *    exponential decay to a fraction of peak, then a slow decay that continues
 *    even while the key is held. A piano note dies away under your finger; a
 *    flat sustain is the single thing that makes a synth stop sounding like a
 *    piano.
 *  - The filter envelope opens bright and closes down. Real strings lose their
 *    upper partials faster than their fundamental, and sweeping a lowpass down
 *    reproduces that cheaply.
 *
 * The four voices differ in their harmonic table, their envelope times, their
 * filter behaviour and, for honky-tonk, in deliberate detuning.
 */

export type VoiceName = "bright" | "warm" | "honky" | "dark";

export interface VoiceDef {
  label: string;
  blurb: string;
  /** Relative amplitude per harmonic, starting at the fundamental. */
  harmonics: number[];
  attack: number;
  /** Time to fall from peak to `sustain` of peak. */
  decay: number;
  sustain: number;
  /** Seconds for the slow decay that runs while the key is held. */
  tail: number;
  release: number;
  /** Lowpass cutoff as a multiple of the note frequency, at strike and settled. */
  filterOpen: number;
  filterClose: number;
  /** Detune in cents for a second oscillator, or 0 for none. */
  detune: number;
  gain: number;
}

/**
 * Voices as described: bright is sharp and clear, warm is soulful and blended,
 * honky-tonk jangles, dark is heavy and slow.
 *
 * The request listed both "warm or mellow" and "dark or mellow", which overlap.
 * They are split here into the two distinct things that were probably meant: a
 * soft, blended, singing tone, and a much darker one with the top end rolled
 * well off.
 */
export const VOICES: Record<VoiceName, VoiceDef> = {
  bright: {
    label: "Bright",
    blurb: "Sharp attack, clean cutoff, notes stay separate",
    // Strong upper partials, and odd ones emphasised, which reads as clarity.
    harmonics: [1, 0.62, 0.44, 0.3, 0.24, 0.16, 0.12, 0.09, 0.06, 0.04],
    attack: 0.002,
    decay: 0.16,
    sustain: 0.4,
    tail: 3.2,
    release: 0.14,
    filterOpen: 14,
    filterClose: 5,
    detune: 0,
    gain: 0.5,
  },
  warm: {
    label: "Warm",
    blurb: "Blended and soulful, made for legato",
    harmonics: [1, 0.5, 0.22, 0.12, 0.06, 0.03, 0.015],
    attack: 0.014,
    decay: 0.35,
    sustain: 0.58,
    tail: 5.5,
    release: 0.4,
    filterOpen: 7,
    filterClose: 3,
    detune: 0,
    gain: 0.56,
  },
  honky: {
    label: "Honky-Tonk",
    blurb: "Aged strings, jangling and lively",
    // Midrange-heavy with a bump around the fourth and fifth partials.
    harmonics: [1, 0.55, 0.5, 0.46, 0.4, 0.26, 0.2, 0.14, 0.1],
    attack: 0.002,
    decay: 0.12,
    sustain: 0.34,
    tail: 2.2,
    release: 0.1,
    filterOpen: 11,
    filterClose: 4.5,
    // The whole character: a second string pulled far enough out of tune to beat.
    detune: 17,
    gain: 0.42,
  },
  dark: {
    label: "Dark",
    blurb: "Heavy fundamental, slow and shadowed",
    harmonics: [1, 0.34, 0.1, 0.04, 0.015],
    attack: 0.02,
    decay: 0.6,
    sustain: 0.62,
    tail: 7,
    release: 0.55,
    filterOpen: 4,
    filterClose: 1.8,
    detune: 0,
    gain: 0.62,
  },
};

export const VOICE_NAMES = Object.keys(VOICES) as VoiceName[];
export const isVoice = (v: string): v is VoiceName => (VOICE_NAMES as string[]).includes(v);

interface Held {
  oscillators: OscillatorNode[];
  gain: GainNode;
  filter: BiquadFilterNode;
}

/**
 * One engine per component. Created lazily, because a browser will not let an
 * AudioContext start outside a user gesture and a context created at mount
 * would simply arrive suspended.
 */
export class Piano {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private waves = new Map<VoiceName, PeriodicWave>();
  private held = new Map<number, Held>();
  private voice: VoiceName = "bright";

  /** Call from a real user gesture. Safe to call repeatedly. */
  async unlock(): Promise<void> {
    if (!this.ctx) {
      const Ctor: typeof AudioContext =
        window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.85;
      // A gentle ceiling, so a fistful of keys does not clip.
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -10;
      limiter.ratio.value = 6;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.2;
      this.master.connect(limiter);
      limiter.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  get ready() {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /** Audio-clock time, which is the only clock worth scheduling against. */
  now(): number {
    return this.ctx?.currentTime ?? 0;
  }

  setVoice(v: VoiceName) {
    this.voice = v;
  }

  setVolume(v: number) {
    if (this.master) this.master.gain.value = Math.max(0, Math.min(1, v));
  }

  private waveFor(name: VoiceName): PeriodicWave {
    const cached = this.waves.get(name);
    if (cached) return cached;
    const ctx = this.ctx!;
    const h = VOICES[name].harmonics;
    // Index 0 of a PeriodicWave table is DC and must stay silent.
    const real = new Float32Array(h.length + 1);
    const imag = new Float32Array(h.length + 1);
    h.forEach((amp, i) => {
      imag[i + 1] = amp;
    });
    const wave = ctx.createPeriodicWave(real, imag, { disableNormalization: false });
    this.waves.set(name, wave);
    return wave;
  }

  /**
   * Strike a note. `at` is an audio-clock time, defaulting to now, so the
   * scheduler can queue a whole phrase ahead of the playhead.
   *
   * Returns nothing: a note started with an explicit `duration` releases itself,
   * and one without is released by `noteOff`.
   */
  noteOn(midi: number, freq: number, at?: number, duration?: number, velocity = 1): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const def = VOICES[this.voice];
    const t0 = Math.max(at ?? ctx.currentTime, ctx.currentTime);

    // Retriggering the same pitch has to stop the old one, or held notes stack
    // up and the sound turns to mud.
    this.noteOff(midi, t0);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 0.7;
    const open = Math.min(freq * def.filterOpen, ctx.sampleRate / 2 - 1000);
    const close = Math.min(freq * def.filterClose, ctx.sampleRate / 2 - 1000);
    filter.frequency.setValueAtTime(open, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(close, 60), t0 + def.decay * 2 + 0.05);

    const gain = ctx.createGain();
    const peak = def.gain * Math.max(0.05, Math.min(1, velocity));
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + def.attack);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak * def.sustain, 0.0002), t0 + def.attack + def.decay);
    // The slow fall that keeps it a struck string rather than an organ.
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + def.attack + def.decay + def.tail);

    const oscillators: OscillatorNode[] = [];
    const wave = this.waveFor(this.voice);
    const spread = def.detune === 0 ? [0] : [-def.detune / 2, def.detune / 2];
    for (const cents of spread) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave);
      osc.frequency.value = freq;
      osc.detune.value = cents;
      osc.connect(filter);
      osc.start(t0);
      oscillators.push(osc);
    }
    filter.connect(gain);
    gain.connect(this.master);

    const entry: Held = { oscillators, gain, filter };
    this.held.set(midi, entry);

    if (duration !== undefined) {
      this.noteOff(midi, t0 + Math.max(0.03, duration));
    } else {
      // Even a key held forever eventually falls silent, so reclaim the nodes.
      const dies = t0 + def.attack + def.decay + def.tail + 0.1;
      for (const osc of oscillators) osc.stop(dies);
    }
  }

  /** Release a note, optionally at a scheduled time. */
  noteOff(midi: number, at?: number): void {
    const entry = this.held.get(midi);
    if (!entry || !this.ctx) return;
    const def = VOICES[this.voice];
    const t = Math.max(at ?? this.ctx.currentTime, this.ctx.currentTime);

    // Cancel the scheduled decay from `t` onward, but hold the value it had
    // reached, or the release would jump from silence and click.
    entry.gain.gain.cancelScheduledValues(t);
    entry.gain.gain.setValueAtTime(Math.max(entry.gain.gain.value, 0.0002), t);
    entry.gain.gain.exponentialRampToValueAtTime(0.0001, t + def.release);
    for (const osc of entry.oscillators) {
      try {
        osc.stop(t + def.release + 0.02);
      } catch {
        // Already stopped, which is not a problem.
      }
    }
    this.held.delete(midi);
  }

  /** Silence everything, for stop and for unmount. */
  allOff(): void {
    for (const midi of [...this.held.keys()]) this.noteOff(midi);
  }

  /**
   * A metronome click, built from a short filtered noise burst plus a pitched
   * blip. Noise alone is mushy at low volume; a pitched component makes the
   * downbeat legible even under a chord.
   */
  click(at: number, accent: boolean): void {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = Math.max(at, ctx.currentTime);

    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = accent ? 1600 : 1050;

    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = accent ? 1800 : 1200;
    band.Q.value = 1.4;

    const g = ctx.createGain();
    const level = accent ? 0.28 : 0.16;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(level, t + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);

    osc.connect(band);
    band.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  dispose(): void {
    this.allOff();
    void this.ctx?.close();
    this.ctx = null;
    this.master = null;
    this.waves.clear();
  }
}
