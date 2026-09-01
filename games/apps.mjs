/**
 * The single source of truth for what this server ships.
 *
 * Plain ESM with no dependencies so the build scripts, the bundler and the
 * TypeScript server all read the same list. `games/registry.ts` imports this
 * and attaches the Zod schemas and tool handlers; `scripts/*.mjs` import it to
 * derive Vite inputs and bundled HTML files. Adding a game means adding one
 * entry here and one folder under `src/`.
 *
 * Three kinds of entry:
 *
 *  - `kind: "app"`   the six original mini apps. Own tool, own bundle, own
 *                    `index.tsx` that calls `renderApp` directly. Already
 *                    shipped and submitted, so they are left untouched.
 *  - `kind: "hero"`  a headline game. Own tool and own bundle so "play tetris"
 *                    resolves directly and downloads only that game.
 *  - `kind: "arcade"` everything else. Reached through the single `play` tool
 *                    and served from one shared `arcade.html` bundle, because
 *                    a tool's UI resource is bound at registration time and
 *                    cannot be swapped per call.
 *
 * `hero` and `arcade` games both export a default React component from
 * `src/<name>/index.tsx`. Heroes additionally get a generated `main.tsx` entry
 * that mounts it; arcade games are mounted by the shared dispatcher.
 */

/**
 * @typedef {object} AppEntry
 * @property {string} name      Tool name and `src/` directory name.
 * @property {"app"|"hero"|"arcade"} kind
 * @property {string} title     Human title shown in the UI and the picker.
 * @property {string} blurb     One line for the arcade picker.
 * @property {string} [group]   Picker section for arcade games.
 */

/** The six original mini apps. Untouched by the arcade work. */
export const ORIGINAL_APPS = [
  { name: "color-picker", kind: "app", title: "Color Picker", blurb: "Pick a colour, get the hex" },
  { name: "dice", kind: "app", title: "Roll Dice", blurb: "Roll up to five dice" },
  { name: "coin", kind: "app", title: "Flip a Coin", blurb: "Heads or tails" },
  { name: "card", kind: "app", title: "Draw a Card", blurb: "One from a shuffled deck" },
  { name: "wheel", kind: "app", title: "Spin the Wheel", blurb: "Wheel of fortune with your own labels" },
  { name: "decision-dice", kind: "app", title: "Decision Dice", blurb: "A die with words on it" },
  { name: "wordle", kind: "app", title: "Wordle", blurb: "Guess the model's words" },
  { name: "snake", kind: "app", title: "Snake", blurb: "The classic crawl" },
];

/** Headline games. Each gets its own tool and its own bundle. */
export const HERO_GAMES = [
  { name: "tetris", kind: "hero", title: "Tetris", blurb: "Stack, clear, survive", group: "Arcade" },
  { name: "2048", kind: "hero", title: "2048", blurb: "Slide and merge to 2048", group: "Puzzle" },
  { name: "minesweeper", kind: "hero", title: "Minesweeper", blurb: "Clear the field, flag the mines", group: "Puzzle" },
  { name: "quiz-duel", kind: "hero", title: "Quiz Duel", blurb: "Trivia on any topic you name", group: "Model" },
  { name: "story-quest", kind: "hero", title: "Story Quest", blurb: "A branching adventure the model writes", group: "Model" },
  { name: "codenames", kind: "hero", title: "Codenames", blurb: "The model is your spymaster", group: "Model" },
  { name: "music-keyboard", kind: "hero", title: "Music Keyboard", blurb: "An 88-key piano, and songs the model writes for it", group: "Model" },
];

/** Everything else, reached through the single `play` tool. */
export const ARCADE_GAMES = [
  // Model is the engine.
  { name: "twenty-questions", kind: "arcade", title: "20 Questions", blurb: "The model guesses what you are thinking of", group: "Model" },
  { name: "hangman", kind: "arcade", title: "Hangman", blurb: "Themed words, one hint if you beg", group: "Model" },
  { name: "emoji-riddle", kind: "arcade", title: "Emoji Riddle", blurb: "Decode films and idioms from emoji", group: "Model" },
  { name: "higher-lower", kind: "arcade", title: "Higher or Lower", blurb: "Which number is bigger, endlessly", group: "Model" },
  { name: "word-search", kind: "arcade", title: "Word Search", blurb: "Find the model's themed words", group: "Model" },

  // Arcade.
  { name: "asteroids", kind: "arcade", title: "Asteroids", blurb: "Blast the rocks, with triple shot, rapid fire, shields and bombs", group: "Arcade" },
  { name: "pacman", kind: "arcade", title: "Pac-Man", blurb: "Four ghosts, each hunting differently", group: "Arcade" },
  { name: "breakout", kind: "arcade", title: "Breakout", blurb: "Paddle, bricks, powerups", group: "Arcade" },
  { name: "flappy", kind: "arcade", title: "Flappy", blurb: "One tap, many deaths", group: "Arcade" },
  { name: "balloon", kind: "arcade", title: "Hot Air Balloon", blurb: "Hold to rise, collect bubbles, miss the spikes", group: "Arcade" },
  { name: "stack-tower", kind: "arcade", title: "Stack Tower", blurb: "Time each drop, the tower narrows", group: "Arcade" },
  { name: "aim-trainer", kind: "arcade", title: "Aim Trainer", blurb: "Thirty seconds of targets", group: "Arcade" },

  // Puzzle.
  { name: "sudoku", kind: "arcade", title: "Sudoku", blurb: "Generated, solvable, four difficulties", group: "Puzzle" },
  { name: "nonogram", kind: "arcade", title: "Nonogram", blurb: "Picross from the model's bitmap", group: "Puzzle" },
  { name: "sokoban", kind: "arcade", title: "Sokoban", blurb: "Push every crate onto a target", group: "Puzzle" },
  { name: "mastermind", kind: "arcade", title: "Mastermind", blurb: "Break the colour code in ten", group: "Puzzle" },

  // Versus.
  { name: "rock-paper-scissors", kind: "arcade", title: "Stone Paper Scissors", blurb: "Stone paper scissors, or rock paper scissors, against an AI that reads your habits", group: "Versus" },
  { name: "connect-four", kind: "arcade", title: "Connect Four", blurb: "Four in a row against minimax", group: "Versus" },
  { name: "ultimate-ttt", kind: "arcade", title: "Ultimate Tic-Tac-Toe", blurb: "Nine boards, one winner", group: "Versus" },
  { name: "blackjack", kind: "arcade", title: "Blackjack", blurb: "Bet, split, double, bust", group: "Versus" },
  { name: "battleship", kind: "arcade", title: "Battleship", blurb: "Sink the fleet before it sinks yours", group: "Versus" },
  { name: "yahtzee", kind: "arcade", title: "Yahtzee", blurb: "Five dice, thirteen boxes", group: "Versus" },
];

/** Every new game, hero and arcade alike. These share the game shell. */
export const ALL_GAMES = [...HERO_GAMES, ...ARCADE_GAMES];

/** Everything the server can serve. */
export const ALL_APPS = [...ORIGINAL_APPS, ...HERO_GAMES, ...ARCADE_GAMES];

/** Picker sections, in display order. */
export const GROUPS = ["Model", "Arcade", "Puzzle", "Versus"];

/**
 * Where the Vite entry documents live, relative to the project root.
 *
 * They sit in one folder rather than loose at the root: there is one per app,
 * so at the root they outnumbered every other top-level file put together. Only
 * `index.html`, the dev launcher Vite serves at `/`, stays outside, because
 * Vite resolves `/` to the root document by convention.
 */
export const ENTRY_DIR = "entries";

/**
 * Vite build inputs, as paths from the project root. The originals and the
 * heroes each build to their own single-file HTML; every arcade game rides in
 * `arcade.html`.
 */
export const BUILD_INPUTS = [
  ...ORIGINAL_APPS.map((a) => `${ENTRY_DIR}/${a.name}.html`),
  ...HERO_GAMES.map((a) => `${ENTRY_DIR}/${a.name}.html`),
  `${ENTRY_DIR}/arcade.html`,
];

/**
 * Files `scripts/bundle-html.mjs` inlines for the server to serve.
 *
 * Same list, still as paths. The server addresses an app by bare file name
 * (`snake.html`), which is an identity rather than a location, so
 * `bundle-html.mjs` reduces these to their base names for its loader keys.
 * That keeps `games/registry.ts` free of build layout.
 */
export const BUNDLED_FILES = BUILD_INPUTS;
