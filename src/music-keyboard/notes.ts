/**
 * @file Pitch names, the 88-key layout, the QWERTY mapping and the key colours.
 *
 * Split out of the component because none of it is React and all of it is worth
 * reading on its own.
 */

/** A full-size piano: A0 up to C8, which is MIDI 21 to 108. */
export const LOWEST = 21;
export const HIGHEST = 108;
export const KEY_COUNT = HIGHEST - LOWEST + 1;

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

/** Semitone offsets that are accidentals, i.e. the ones normally coloured black. */
const ACCIDENTAL = new Set([1, 3, 6, 8, 10]);

export const pitchClass = (midi: number) => ((midi % 12) + 12) % 12;
export const octaveOf = (midi: number) => Math.floor(midi / 12) - 1;
export const isAccidental = (midi: number) => ACCIDENTAL.has(pitchClass(midi));
export const nameOf = (midi: number) => `${NAMES[pitchClass(midi)]}${octaveOf(midi)}`;

/** Equal temperament from A4 = 440Hz. */
export const freqOf = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

const LETTER_SEMITONE: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/**
 * Parse a note name the model might send: "C4", "F#3", "Bb5", "Eb2".
 *
 * Flats are accepted because a model writing music will use them, and refusing
 * them would silently drop half of any piece in a flat key.
 */
export function parseNote(input: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(input.trim());
  if (!m) return null;
  const letter = m[1].toUpperCase();
  const accidental = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  const octave = Number(m[3]);
  const midi = (octave + 1) * 12 + LETTER_SEMITONE[letter] + accidental;
  return midi >= 0 && midi <= 127 ? midi : null;
}

/* ------------------------------------------------------------------ */
/* Colour                                                             */
/* ------------------------------------------------------------------ */

/**
 * Hue per pitch class, ordered by the circle of fifths rather than
 * chromatically.
 *
 * Chromatic ordering would produce a smooth rainbow across the keyboard, which
 * looks pleasant and is useless: neighbouring keys would be neighbouring hues
 * and so hard to tell apart at speed. Stepping by fifths puts adjacent
 * semitones almost opposite each other on the wheel, so every key contrasts
 * with the ones beside it, and notes an octave apart share a colour, which is
 * the pattern worth being able to see.
 */
const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
export const HUE: number[] = (() => {
  const out = new Array(12).fill(0);
  FIFTHS.forEach((pc, i) => {
    out[pc] = i * 30;
  });
  return out;
})();

export const hueOf = (midi: number) => HUE[pitchClass(midi)];

/* ------------------------------------------------------------------ */
/* Layout                                                             */
/* ------------------------------------------------------------------ */

export interface KeySpec {
  midi: number;
  accidental: boolean;
  /** Index among the naturals, which is what sets horizontal position. */
  naturalIndex: number;
}

/**
 * Every key with the information needed to place it.
 *
 * Naturals tile left to right at a fixed width. Accidentals sit between two
 * naturals and are positioned from the natural index of the one below, so the
 * whole layout follows from counting naturals.
 */
export const KEYS: KeySpec[] = (() => {
  const out: KeySpec[] = [];
  let naturals = 0;
  for (let midi = LOWEST; midi <= HIGHEST; midi++) {
    const acc = isAccidental(midi);
    out.push({ midi, accidental: acc, naturalIndex: acc ? naturals - 1 : naturals });
    if (!acc) naturals++;
  }
  return out;
})();

export const NATURAL_COUNT = KEYS.filter((k) => !k.accidental).length;

/* ------------------------------------------------------------------ */
/* QWERTY                                                            */
/* ------------------------------------------------------------------ */

/**
 * Two rows of the keyboard become two octaves, the layout every tracker and
 * DAW uses: the home row plus the row above it are the naturals, and the keys
 * physically between them are the accidentals. Semitone offsets are relative to
 * the C the player has shifted to.
 */
export const QWERTY: Record<string, number> = {
  // Lower octave: Z row naturals, S row accidentals.
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ",": 12, l: 13, ".": 14,
  // Upper octave: Q row naturals, number row accidentals.
  q: 12, "2": 13, w: 14, "3": 15, e: 16, r: 17, "5": 18, t: 19, "6": 20, y: 21, "7": 22, u: 23,
  i: 24, "9": 25, o: 26, "0": 27, p: 28,
};

/** Which physical key plays a given semitone offset, for printing on the keys. */
export const KEY_LABEL: Record<number, string> = (() => {
  const out: Record<number, string> = {};
  for (const [key, offset] of Object.entries(QWERTY)) {
    // First binding wins, so the lower row labels the notes it reaches.
    if (out[offset] === undefined) out[offset] = key === "," ? "," : key === "." ? "." : key.toUpperCase();
  }
  return out;
})();
