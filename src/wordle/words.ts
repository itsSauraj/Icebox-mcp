/**
 * @file Bundled word dictionary for the Wordle game. Fully self-contained — no
 * network or API is ever used. Words are grouped by length (4–7) so the game
 * can build a deliberately non-uniform grid of varying-width words.
 *
 * Every entry is a real, common English word of the length of its bucket.
 */
import { randInt, shuffle } from "../lib/rng";

/** Lengths we mix into a game, shortest → longest. */
export const LENGTHS = [4, 5, 6, 7] as const;

/** Real English words grouped by exact length. */
export const WORDS: Record<number, string[]> = {
  4: [
    "able", "back", "ball", "bath", "bear", "bell", "bird", "blue", "boat", "bold",
    "bone", "book", "calm", "camp", "card", "cave", "city", "clay", "coal", "coat",
    "coin", "cold", "cook", "corn", "crab", "dark", "dawn", "deer", "desk", "dice",
    "dish", "dive", "dome", "door", "dove", "down", "drum", "duck", "dust", "east",
    "easy", "face", "fair", "farm", "fast", "fern", "fire", "fish", "flag", "foam",
  ],
  5: [
    "apple", "beach", "bread", "brick", "brush", "chair", "chess", "cloud", "dance", "dream",
    "eagle", "earth", "flame", "flute", "fruit", "ghost", "glass", "globe", "grape", "grass",
    "green", "heart", "honey", "horse", "house", "juice", "knife", "koala", "lemon", "light",
    "lucky", "mango", "maple", "money", "mouse", "music", "night", "ocean", "olive", "otter",
    "paint", "peach", "pearl", "piano", "pizza", "plant", "pride", "queen", "quilt", "river",
  ],
  6: [
    "animal", "autumn", "banana", "basket", "bottle", "branch", "bridge", "bucket", "camera", "candle",
    "canvas", "carpet", "castle", "cheese", "cherry", "circle", "coffee", "copper", "cotton", "desert",
    "dinner", "dragon", "engine", "flower", "forest", "garden", "guitar", "hammer", "island", "jacket",
    "jungle", "ladder", "laptop", "market", "meadow", "mirror", "monkey", "museum", "needle", "orange",
    "palace", "pencil", "pepper", "planet", "rabbit", "ribbon", "rocket", "silver", "spider", "spring",
  ],
  7: [
    "academy", "amazing", "balloon", "bedroom", "brother", "cabinet", "captain", "ceiling", "chicken", "compass",
    "concert", "cottage", "country", "crystal", "cushion", "diamond", "dolphin", "drawing", "factory", "feather",
    "gallery", "general", "giraffe", "harvest", "holiday", "journey", "kitchen", "lantern", "library", "machine",
    "measure", "monster", "morning", "musical", "network", "orchard", "pattern", "penguin", "picture", "pilgrim",
    "popcorn", "printer", "problem", "pyramid", "rainbow", "science", "station", "teacher", "tornado", "village",
  ],
};

/**
 * Generate `count` UPPERCASE target words with deliberately varying lengths.
 *
 * Words are chosen randomly (shuffled pools) while cycling through the length
 * buckets round-robin, which guarantees the set mixes lengths 4–7 so the
 * overview grid is non-uniform. Never repeats a word. Purely client-side.
 */
export function generateTargets(count: number): string[] {
  const pools = new Map<number, string[]>();
  for (const len of LENGTHS) {
    // Guard against any accidental mis-bucketed entry by re-checking length.
    const clean = (WORDS[len] ?? []).filter((w) => w.length === len);
    pools.set(len, shuffle(clean).map((w) => w.toUpperCase()));
  }

  const cursors = new Map<number, number>(LENGTHS.map((l) => [l, 0]));
  const out: string[] = [];
  const start = randInt(0, LENGTHS.length - 1);
  let step = 0;

  while (out.length < count) {
    const len = LENGTHS[(start + step) % LENGTHS.length];
    step++;
    const pool = pools.get(len)!;
    const cursor = cursors.get(len)!;
    if (cursor < pool.length) {
      out.push(pool[cursor]);
      cursors.set(len, cursor + 1);
    }
    // Stop early if every pool is exhausted (can't happen for count ≤ 40).
    if (LENGTHS.every((l) => cursors.get(l)! >= pools.get(l)!.length)) break;
  }

  return out;
}
