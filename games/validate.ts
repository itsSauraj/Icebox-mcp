/**
 * @file Validators for model-supplied game content.
 *
 * Games in the "model is the engine" group take their material from the model:
 * quiz questions, story beats, themed words, emoji puzzles, fact pairs. None of
 * it can be trusted to arrive in the shape the schema promised, so every such
 * handler runs its input through here before the app ever sees it.
 *
 * The rule the original Wordle handler established and everything now follows:
 * clean, filter, dedupe, cap, and fall back to the app's own material rather
 * than shipping something broken to the UI.
 */

/** Strip control characters and collapse whitespace. */
export function cleanText(input: unknown, maxLen = 240): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** Lowercase alphabetic word, used by Wordle, Hangman and Word Search. */
export function cleanWord(input: unknown, min = 3, max = 12): string | null {
  if (typeof input !== "string") return null;
  const w = input.toLowerCase().replace(/[^a-z]/g, "");
  return w.length >= min && w.length <= max ? w : null;
}

/**
 * Clean a list of words: drop anything unusable, drop duplicates, cap the
 * count. Returns an empty array rather than throwing so the caller can fall
 * back to its own word list.
 */
export function cleanWords(
  input: unknown,
  { min = 3, max = 12, limit = 40 }: { min?: number; max?: number; limit?: number } = {},
): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const w = cleanWord(raw, min, max);
    if (!w || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= limit) break;
  }
  return out;
}

/** Clean a list of free-text strings (labels, clues, options, story choices). */
export function cleanList(
  input: unknown,
  { limit = 40, maxLen = 240 }: { limit?: number; maxLen?: number } = {},
): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const t = cleanText(raw, maxLen);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

export interface QuizQuestion {
  question: string;
  options: string[];
  answer: number;
  note?: string;
}

/**
 * Keep only questions that are actually playable: a prompt, at least two
 * distinct options, and an answer index that points at one of them. A question
 * whose answer index is out of range is silently dropped rather than repaired,
 * because a repaired answer would be a wrong answer.
 */
export function cleanQuestions(input: unknown, limit = 25): QuizQuestion[] {
  if (!Array.isArray(input)) return [];
  const out: QuizQuestion[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const question = cleanText(r.question, 300);
    const options = cleanList(r.options, { limit: 6, maxLen: 120 });
    const answer = typeof r.answer === "number" ? Math.trunc(r.answer) : -1;
    if (!question || options.length < 2) continue;
    if (answer < 0 || answer >= options.length) continue;
    const note = cleanText(r.note, 200);
    out.push({ question, options, answer, ...(note ? { note } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

export interface FactPair {
  left: string;
  right: string;
  leftValue: number;
  rightValue: number;
  unit?: string;
}

/** Fact pairs for Higher or Lower. Equal values are dropped, being unplayable. */
export function cleanFactPairs(input: unknown, limit = 30): FactPair[] {
  if (!Array.isArray(input)) return [];
  const out: FactPair[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const left = cleanText(r.left, 120);
    const right = cleanText(r.right, 120);
    const leftValue = Number(r.leftValue);
    const rightValue = Number(r.rightValue);
    if (!left || !right) continue;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) continue;
    if (leftValue === rightValue) continue;
    const unit = cleanText(r.unit, 24);
    out.push({ left, right, leftValue, rightValue, ...(unit ? { unit } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

export interface RiddleItem {
  emoji: string;
  answer: string;
  hint?: string;
}

/** Emoji riddles. The emoji field keeps its symbols; only the answer is normalised. */
export function cleanRiddles(input: unknown, limit = 25): RiddleItem[] {
  if (!Array.isArray(input)) return [];
  const out: RiddleItem[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const emoji = cleanText(r.emoji, 40);
    const answer = cleanText(r.answer, 120);
    if (!emoji || !answer) continue;
    const hint = cleanText(r.hint, 120);
    out.push({ emoji, answer, ...(hint ? { hint } : {}) });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A monochrome bitmap for Nonogram. Accepts rows of any characters: anything
 * that is not a space, a dot, a zero or an underscore counts as filled. Rows
 * are padded or trimmed to the width of the first row so the grid is always
 * rectangular, and an all-empty grid is rejected as unplayable.
 */
export function cleanBitmap(input: unknown, maxSize = 15): boolean[][] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const rows = input.filter((r): r is string => typeof r === "string").slice(0, maxSize);
  if (rows.length === 0) return null;
  const width = Math.min(maxSize, rows[0].length);
  if (width === 0) return null;
  const empty = new Set([" ", ".", "0", "_", "-"]);
  const grid = rows.map((row) => {
    const cells: boolean[] = [];
    for (let i = 0; i < width; i++) cells.push(!empty.has(row[i] ?? " "));
    return cells;
  });
  return grid.some((row) => row.some(Boolean)) ? grid : null;
}

export interface StoryBeat {
  scene: string;
  choices: string[];
}

/** One story beat: prose plus two to four choices. */
export function cleanBeat(input: unknown): StoryBeat | null {
  if (!input || typeof input !== "object") return null;
  const r = input as Record<string, unknown>;
  const scene = cleanText(r.scene, 900);
  const choices = cleanList(r.choices, { limit: 4, maxLen: 120 });
  if (!scene || choices.length < 2) return null;
  return { scene, choices };
}
