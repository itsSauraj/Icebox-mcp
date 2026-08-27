/**
 * @file Tool definitions for everything this server serves.
 *
 * `games/apps.mjs` holds the list of apps. This file attaches the Zod schemas,
 * the model-facing descriptions and the handlers, so `server.ts` stays a thin
 * generic loop over three arrays rather than thirty hand-written blocks.
 *
 * Handlers are deliberately tiny. Each one seeds the UI and returns a text
 * summary for hosts that cannot render an app. Anything the model supplied is
 * run through `games/validate.ts` first, and every handler falls back to its
 * own material rather than passing bad content to the UI.
 */
import { z } from "zod";
import { ARCADE_GAMES, HERO_GAMES } from "./apps.mjs";
import {
  cleanBeat,
  cleanBitmap,
  cleanFactPairs,
  cleanList,
  cleanQuestions,
  cleanRiddles,
  cleanText,
  cleanWords,
} from "./validate.js";

/* ------------------------------------------------------------------ */
/* Shared helpers, kept identical to the originals in server.ts        */
/* ------------------------------------------------------------------ */

export const randInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];

export const HEX_RE = /^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
const normalizeHex = (input?: string) =>
  input && HEX_RE.test(input.trim()) ? `#${input.trim().replace(/^#/, "").toLowerCase()}` : "#2563eb";

const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
const SUITS = ["♠", "♥", "♦", "♣"];
const SUIT_NAME: Record<string, string> = { "♠": "Spades", "♥": "Hearts", "♦": "Diamonds", "♣": "Clubs" };
const WHEEL_DEFAULT = ["100", "200", "300", "400", "500", "Bankrupt", "600", "700", "800", "Free Spin"];
const FACES_DEFAULT = ["Yes", "No", "Maybe", "Definitely", "No way", "Ask again"];

export const READONLY_ANNOTATIONS = {
  readOnlyHint: true,
  openWorldHint: false,
  destructiveHint: false,
} as const;

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

/** What a handler gives back: a line for the model, and seed data for the UI. */
export interface ToolOutcome {
  text: string;
  data: Record<string, unknown>;
}

export interface ToolSpec {
  /** Tool name. Also the `src/` directory and the built HTML file stem. */
  name: string;
  title: string;
  description: string;
  /** Which bundled HTML renders this tool. */
  file: string;
  inputSchema: z.ZodRawShape;
  outputSchema: z.ZodObject<z.ZodRawShape>;
  run: (args: Record<string, unknown>) => ToolOutcome;
}

/* ------------------------------------------------------------------ */
/* The six original mini apps, plus Wordle and Snake                   */
/* ------------------------------------------------------------------ */

export const ORIGINAL_SPECS: ToolSpec[] = [
  {
    name: "color-picker",
    title: "Color Picker",
    file: "color-picker.html",
    description:
      "Opens an interactive color picker, optionally seeded with a hex color. The user's chosen color is reported back.",
    inputSchema: {
      initialColor: z
        .string()
        .regex(HEX_RE, "Must be a hex color like #2563eb")
        .optional()
        .describe("Initial color (hex)."),
    },
    outputSchema: z.object({ color: z.string() }),
    run: (a) => {
      const color = normalizeHex(a.initialColor as string | undefined);
      return { text: `Color picker opened at ${color}.`, data: { color } };
    },
  },
  {
    name: "dice",
    title: "Roll Dice",
    file: "dice.html",
    description:
      "Rolls one or more six-sided dice (default 1) and returns the faces and total. The UI supports re-rolling and a two-player 'highest total wins' duel.",
    inputSchema: {
      count: z.number().int().min(1).max(5).optional().describe("Number of dice to roll (1 to 5)."),
    },
    outputSchema: z.object({ rolls: z.array(z.number()), total: z.number() }),
    run: (a) => {
      const n = (a.count as number | undefined) ?? 1;
      const rolls = Array.from({ length: n }, () => randInt(1, 6));
      const total = rolls.reduce((x, y) => x + y, 0);
      return { text: `Rolled ${rolls.join(", ")} (total ${total}).`, data: { rolls, total } };
    },
  },
  {
    name: "coin-flip",
    title: "Flip a Coin",
    file: "coin.html",
    description: "Flips a fair coin and returns Heads or Tails.",
    inputSchema: {},
    outputSchema: z.object({ result: z.enum(["Heads", "Tails"]) }),
    run: () => {
      const result = Math.random() < 0.5 ? "Heads" : "Tails";
      return { text: `The coin landed on ${result}.`, data: { result } };
    },
  },
  {
    name: "draw-card",
    title: "Draw a Card",
    file: "card.html",
    description: "Draws a random card from a standard 52-card deck.",
    inputSchema: {},
    outputSchema: z.object({ rank: z.string(), suit: z.string(), label: z.string() }),
    run: () => {
      const rank = pick(RANKS);
      const suit = pick(SUITS);
      const label = `${rank}${suit}`;
      return { text: `Drew the ${rank} of ${SUIT_NAME[suit]} (${label}).`, data: { rank, suit, label } };
    },
  },
  {
    name: "spin-wheel",
    title: "Spin the Wheel",
    file: "wheel.html",
    description:
      "Spins a Wheel-of-Fortune style wheel. Provide custom labels (as many as you like) or use the defaults. Returns the winning label.",
    inputSchema: {
      labels: z.array(z.string()).min(2).max(24).optional().describe("Wheel segment labels (2 to 24)."),
    },
    outputSchema: z.object({ labels: z.array(z.string()), winner: z.string(), index: z.number() }),
    run: (a) => {
      const given = a.labels as string[] | undefined;
      const segs = given && given.length >= 2 ? given : WHEEL_DEFAULT;
      const index = randInt(0, segs.length - 1);
      const winner = segs[index];
      return { text: `The wheel landed on "${winner}".`, data: { labels: segs, winner, index } };
    },
  },
  {
    name: "decision-dice",
    title: "Decision Dice",
    file: "decision-dice.html",
    description:
      "Rolls a die with custom text faces (e.g. Yes/No/Maybe). Provide your own faces or use the defaults. Returns the chosen face.",
    inputSchema: {
      faces: z.array(z.string()).min(1).max(12).optional().describe("Custom die faces (1 to 12)."),
    },
    outputSchema: z.object({ faces: z.array(z.string()), result: z.string() }),
    run: (a) => {
      const given = a.faces as string[] | undefined;
      const set = given && given.length ? given : FACES_DEFAULT;
      const result = pick(set);
      return { text: `The decision die landed on "${result}".`, data: { faces: set, result } };
    },
  },
  {
    name: "wordle",
    title: "Wordle",
    file: "wordle.html",
    description:
      "Play a multi-word Wordle. The user only says how many words (5 to 40). YOU generate that many real, meaningful English words of VARYING lengths (a mix of about 4 to 8 letters) from diverse topics, and pass them as `words`. If you cannot, pass just `count` and the app picks words itself.",
    inputSchema: {
      count: z.number().int().min(5).max(40).optional().describe("How many words to play (5 to 40)."),
      words: z
        .array(z.string())
        .min(5)
        .max(40)
        .optional()
        .describe("Real English words of mixed lengths (about 4 to 8 letters) to guess."),
    },
    outputSchema: z.object({ words: z.array(z.string()), count: z.number() }),
    run: (a) => {
      const unique = cleanWords(a.words, { min: 3, max: 10, limit: 40 });
      const requested = a.count as number | undefined;
      const n = Math.min(40, Math.max(5, requested ?? (unique.length || 5)));
      const text = unique.length
        ? `Starting Wordle with ${unique.length} words.`
        : `Starting Wordle with ${n} words.`;
      return { text, data: { words: unique, count: n } };
    },
  },
  {
    name: "snake",
    title: "Snake",
    file: "snake.html",
    description:
      "Opens a playable Snake game (SVG board, keyboard + touch controls, adjustable speed, hard/soft walls, fullscreen). Optionally set the starting speed.",
    inputSchema: {
      speed: z.enum(["slow", "normal", "fast"]).optional().describe("Starting speed."),
    },
    outputSchema: z.object({ speed: z.string() }),
    run: (a) => {
      const s = (a.speed as string | undefined) ?? "normal";
      return { text: `Snake ready (${s}).`, data: { speed: s } };
    },
  },
];

/* ------------------------------------------------------------------ */
/* Hero games: own tool, own bundle                                    */
/* ------------------------------------------------------------------ */

const DIFFICULTY = z.enum(["easy", "normal", "hard", "expert"]);

const heroFile = (name: string) => `${name}.html`;
const heroTitle = (name: string) => HERO_GAMES.find((g) => g.name === name)?.title ?? name;

export const HERO_SPECS: ToolSpec[] = [
  {
    name: "tetris",
    title: heroTitle("tetris"),
    file: heroFile("tetris"),
    description:
      "Opens a playable Tetris game with SRS rotation, a hold slot, a ghost piece, a 7-bag randomizer and a level speed curve. Keyboard, swipe and on-screen controls. Optionally set the starting level.",
    inputSchema: {
      level: z.number().int().min(1).max(10).optional().describe("Starting level, 1 (slow) to 10 (very fast)."),
    },
    outputSchema: z.object({ game: z.string(), level: z.number() }),
    run: (a) => {
      const level = Math.min(10, Math.max(1, (a.level as number | undefined) ?? 1));
      return { text: `Tetris ready at level ${level}.`, data: { game: "tetris", level } };
    },
  },
  {
    name: "2048",
    title: heroTitle("2048"),
    file: heroFile("2048"),
    description:
      "Opens a playable 2048. Slide tiles with the arrow keys or a swipe to merge equal numbers and reach 2048. Optionally set the board size.",
    inputSchema: {
      size: z.number().int().min(3).max(6).optional().describe("Board size, 3 to 6 (default 4)."),
    },
    outputSchema: z.object({ game: z.string(), size: z.number() }),
    run: (a) => {
      const size = Math.min(6, Math.max(3, (a.size as number | undefined) ?? 4));
      return { text: `2048 ready on a ${size} by ${size} board.`, data: { game: "2048", size } };
    },
  },
  {
    name: "minesweeper",
    title: heroTitle("minesweeper"),
    file: heroFile("minesweeper"),
    description:
      "Opens a playable Minesweeper with flagging, chording and a first-click-always-safe board. Choose a difficulty preset.",
    inputSchema: {
      difficulty: z
        .enum(["easy", "normal", "hard"])
        .optional()
        .describe("easy is 9x9 with 10 mines, normal is 16x16 with 40, hard is 22x16 with 70."),
    },
    outputSchema: z.object({ game: z.string(), difficulty: z.string() }),
    run: (a) => {
      const difficulty = (a.difficulty as string | undefined) ?? "normal";
      return { text: `Minesweeper ready (${difficulty}).`, data: { game: "minesweeper", difficulty } };
    },
  },
  {
    name: "quiz-duel",
    title: heroTitle("quiz-duel"),
    file: heroFile("quiz-duel"),
    description:
      "Opens a timed trivia game on ANY topic the user names. YOU generate the questions: pass `topic` plus a `questions` array where each entry has `question`, an `options` array of 2 to 6 choices, `answer` as the zero-based index of the correct option, and an optional one-line `note` explaining why. Aim for 10 questions of mixed difficulty and make sure the answer index is correct. If you pass no questions the app falls back to a small built-in set.",
    inputSchema: {
      topic: z.string().max(80).optional().describe("What the quiz is about, e.g. 'Roman history'."),
      questions: z
        .array(
          z.object({
            question: z.string().describe("The question text."),
            options: z.array(z.string()).min(2).max(6).describe("Answer choices."),
            answer: z.number().int().min(0).describe("Zero-based index of the correct option."),
            note: z.string().optional().describe("One line on why that answer is right."),
          }),
        )
        .min(1)
        .max(25)
        .optional()
        .describe("The questions to play. Generate about 10."),
      seconds: z.number().int().min(5).max(60).optional().describe("Seconds per question (default 15)."),
    },
    outputSchema: z.object({
      game: z.string(),
      topic: z.string(),
      questions: z.array(
        z.object({
          question: z.string(),
          options: z.array(z.string()),
          answer: z.number(),
          note: z.string().optional(),
        }),
      ),
      seconds: z.number(),
    }),
    run: (a) => {
      const topic = cleanText(a.topic, 80) || "General knowledge";
      const questions = cleanQuestions(a.questions, 25);
      const seconds = Math.min(60, Math.max(5, (a.seconds as number | undefined) ?? 15));
      const text = questions.length
        ? `Quiz Duel ready: ${questions.length} questions on ${topic}, ${seconds}s each.`
        : `Quiz Duel ready on ${topic} using the built-in question set.`;
      return { text, data: { game: "quiz-duel", topic, questions, seconds } };
    },
  },
  {
    name: "story-quest",
    title: heroTitle("story-quest"),
    file: heroFile("story-quest"),
    description:
      "Opens a choose-your-own-adventure the model writes. Pass a `genre` and the opening beat as `scene` plus 2 to 4 `choices`. When the player picks one the app tells you which, and you call this tool again with the next beat. Track HP and inventory by passing them back each turn. Aim for 10 to 15 beats before an ending.",
    inputSchema: {
      genre: z.string().max(60).optional().describe("Setting and tone, e.g. 'haunted lighthouse'."),
      scene: z.string().max(900).optional().describe("Prose for this beat, 2 to 5 sentences."),
      choices: z.array(z.string()).min(2).max(4).optional().describe("What the player can do next."),
      hp: z.number().int().min(0).max(100).optional().describe("Player health after this beat."),
      inventory: z.array(z.string()).max(12).optional().describe("What the player is carrying."),
      beat: z.number().int().min(1).max(40).optional().describe("Which beat this is, starting at 1."),
      ending: z.boolean().optional().describe("True when this beat ends the story."),
    },
    outputSchema: z.object({
      game: z.string(),
      genre: z.string(),
      scene: z.string(),
      choices: z.array(z.string()),
      hp: z.number(),
      inventory: z.array(z.string()),
      beat: z.number(),
      ending: z.boolean(),
    }),
    run: (a) => {
      const genre = cleanText(a.genre, 60) || "Unknown road";
      const beatData = cleanBeat({ scene: a.scene, choices: a.choices });
      const hp = Math.min(100, Math.max(0, (a.hp as number | undefined) ?? 100));
      const inventory = cleanList(a.inventory, { limit: 12, maxLen: 40 });
      const beat = Math.min(40, Math.max(1, (a.beat as number | undefined) ?? 1));
      const ending = Boolean(a.ending);
      const text = beatData
        ? `Story Quest beat ${beat} (${genre}), ${beatData.choices.length} choices, HP ${hp}.`
        : `Story Quest ready (${genre}). Waiting on an opening scene.`;
      return {
        text,
        data: {
          game: "story-quest",
          genre,
          scene: beatData?.scene ?? "",
          choices: beatData?.choices ?? [],
          hp,
          inventory,
          beat,
          ending,
        },
      };
    },
  },
  {
    name: "codenames",
    title: heroTitle("codenames"),
    file: heroFile("codenames"),
    description:
      "Opens a solo Codenames where YOU are the spymaster. Pass 25 single `words`, a `key` array of 25 role letters in the same order (A for agent, B for bystander, X for assassin, using 9 A, 15 B and 1 X), and your first `clue` as a word plus a `count`. The app tells you what the player guessed and you call again with the next clue.",
    inputSchema: {
      words: z.array(z.string()).length(25).optional().describe("Exactly 25 single words for the grid."),
      key: z
        .array(z.enum(["A", "B", "X"]))
        .length(25)
        .optional()
        .describe("Role per word: A agent, B bystander, X assassin. Use 9 A, 15 B, 1 X."),
      clue: z.string().max(40).optional().describe("A one-word clue."),
      count: z.number().int().min(1).max(9).optional().describe("How many words the clue covers."),
    },
    outputSchema: z.object({
      game: z.string(),
      words: z.array(z.string()),
      key: z.array(z.string()),
      clue: z.string(),
      count: z.number(),
    }),
    run: (a) => {
      const words = cleanWords(a.words, { min: 2, max: 14, limit: 25 });
      const rawKey = Array.isArray(a.key) ? (a.key as unknown[]) : [];
      const key = rawKey
        .map((k) => (k === "A" || k === "B" || k === "X" ? k : "B"))
        .slice(0, 25) as string[];
      const clue = cleanText(a.clue, 40);
      const count = Math.min(9, Math.max(1, (a.count as number | undefined) ?? 1));
      const ready = words.length === 25 && key.length === 25;
      const text = ready
        ? clue
          ? `Codenames: clue "${clue}" for ${count}.`
          : "Codenames grid ready. Send a clue."
        : "Codenames ready. Send 25 words and a 25-letter key.";
      return { text, data: { game: "codenames", words, key, clue, count } };
    },
  },
];

/* ------------------------------------------------------------------ */
/* The `play` tool: one entry point for every remaining game           */
/* ------------------------------------------------------------------ */

export const ARCADE_FILE = "arcade.html";
export const ARCADE_NAMES = ARCADE_GAMES.map((g) => g.name) as [string, ...string[]];

const arcadeList = ARCADE_GAMES.map((g) => `${g.name} (${g.blurb.toLowerCase()})`).join(", ");

/**
 * Games that want content from the model. Named in the tool description so the
 * model knows when to bother generating anything, rather than guessing from
 * eighteen separate schemas.
 */
const CONTENT_HINTS = [
  "hangman: pass `topic` and `words` (5 to 15 themed words)",
  "word-search: pass `topic` and `words` (8 to 12 themed words)",
  "emoji-riddle: pass `riddles`, each with `emoji`, `answer` and an optional `hint`",
  "higher-lower: pass `pairs`, each with `left`, `right`, `leftValue`, `rightValue` and an optional `unit`",
  "nonogram: pass `bitmap`, an array of up to 15 equal-length rows where any non-space character is a filled cell",
].join("; ");

export const PLAY_SPEC: ToolSpec = {
  name: "play",
  title: "Play a Game",
  file: ARCADE_FILE,
  description:
    `Opens the Icebox game library, or one game from it.\n\n` +
    `CALL THIS WITH NO ARGUMENTS whenever the user asks what games are available, what they can play, to see the list, or to browse. ` +
    `It renders a visual grid of every game with its icon and name, which is the right answer to those questions. ` +
    `Show that UI rather than describing the games in text.\n\n` +
    `Pass \`game\` to open one directly. Available: ${arcadeList}. ` +
    `Tetris, 2048, Minesweeper, Quiz Duel, Story Quest, Codenames, Snake and Wordle have their own tools; call those by name instead.\n\n` +
    `Some games play better when you supply the content: ${CONTENT_HINTS}. Everything else needs at most a \`difficulty\`.`,
  inputSchema: {
    game: z
      .enum(ARCADE_NAMES)
      .optional()
      .describe("Which game to open. Omit to show the picker."),
    difficulty: DIFFICULTY.optional().describe("For sudoku, connect-four, battleship, mastermind, sokoban, pacman."),
    topic: z.string().max(80).optional().describe("Theme for hangman and word-search."),
    words: z.array(z.string()).min(1).max(20).optional().describe("Themed words for hangman and word-search."),
    riddles: z
      .array(
        z.object({
          emoji: z.string().describe("The emoji puzzle, e.g. a rocket plus a moon."),
          answer: z.string().describe("What it decodes to."),
          hint: z.string().optional(),
        }),
      )
      .min(1)
      .max(25)
      .optional()
      .describe("Puzzles for emoji-riddle."),
    pairs: z
      .array(
        z.object({
          left: z.string(),
          right: z.string(),
          leftValue: z.number(),
          rightValue: z.number(),
          unit: z.string().optional(),
        }),
      )
      .min(1)
      .max(30)
      .optional()
      .describe("Fact pairs for higher-lower. Use real figures."),
    bitmap: z
      .array(z.string())
      .min(3)
      .max(15)
      .optional()
      .describe("Rows for nonogram. Any non-space character is a filled cell."),
  },
  outputSchema: z.object({
    game: z.string(),
    config: z.record(z.string(), z.unknown()),
  }),
  run: (a) => {
    const game = typeof a.game === "string" && ARCADE_NAMES.includes(a.game) ? a.game : "";
    const entry = ARCADE_GAMES.find((g) => g.name === game);

    const config: Record<string, unknown> = {};
    if (a.difficulty) config.difficulty = a.difficulty;

    const topic = cleanText(a.topic, 80);
    if (topic) config.topic = topic;

    const words = cleanWords(a.words, { min: 3, max: 14, limit: 20 });
    if (words.length) config.words = words;

    const riddles = cleanRiddles(a.riddles, 25);
    if (riddles.length) config.riddles = riddles;

    const pairs = cleanFactPairs(a.pairs, 30);
    if (pairs.length) config.pairs = pairs;

    const bitmap = cleanBitmap(a.bitmap, 15);
    if (bitmap) config.bitmap = bitmap;

    const supplied = Object.keys(config).filter((k) => k !== "difficulty");
    const text = entry
      ? `${entry.title} ready.${supplied.length ? ` Using the ${supplied.join(" and ")} you sent.` : ""}`
      : `Showing the Icebox game library: ${ARCADE_GAMES.length} games in the arcade plus eight with their own tools. The grid is on screen, so let the user pick from it.`;

    return { text, data: { game, config } };
  },
};

/** Every tool the server registers, in registration order. */
export const ALL_SPECS: ToolSpec[] = [...ORIGINAL_SPECS, ...HERO_SPECS, PLAY_SPEC];

/** Distinct HTML files that need a UI resource. */
export const RESOURCE_FILES = [...new Set(ALL_SPECS.map((s) => s.file))];
