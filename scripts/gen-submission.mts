/**
 * Generates `chatgpt-app-submission.json` from the tool registry.
 *
 * Fifteen tools with three justifications each is 45 pieces of prose that must
 * agree with what the code actually does. Hand-maintaining that guarantees it
 * drifts: the file in the repository still described six tools long after
 * Wordle and Snake shipped. Deriving it from `games/registry.ts` means a tool
 * cannot be added without its submission entry appearing too.
 *
 * Every tool here is genuinely read-only, closed-world and non-destructive: the
 * apps are self-contained bundles with no network access, and the handlers only
 * shape their own arguments. The per-tool read-only line explains what that
 * particular tool does with its input; the other two are the same claim for
 * every tool because it is the same fact.
 *
 * Run with `npm run gen:submission`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { ALL_SPECS } from "../games/registry.js";

/** What each tool does with its input, for the read-only justification. */
const READ_ONLY: Record<string, string> = {
  "color-picker": "Normalizes an optional hex color and opens a local picker without changing stored or external data.",
  dice: "Generates random dice values and returns the total without changing stored or external data.",
  "coin-flip": "Generates a random Heads or Tails result without changing stored or external data.",
  "draw-card": "Generates a random standard playing card result without changing stored or external data.",
  "spin-wheel": "Picks a random segment from the supplied labels without changing stored or external data.",
  "decision-dice": "Picks a random face from the supplied labels without changing stored or external data.",
  wordle: "Cleans and de-duplicates the supplied word list and opens a local game without changing stored or external data.",
  snake: "Validates an optional speed setting and opens a local game without changing stored or external data.",
  tetris: "Validates an optional starting level and opens a local game without changing stored or external data.",
  "2048": "Validates an optional board size and opens a local game without changing stored or external data.",
  minesweeper: "Validates an optional difficulty preset and opens a local game without changing stored or external data.",
  "quiz-duel": "Validates the supplied quiz questions and opens a local game without changing stored or external data.",
  "story-quest": "Validates the supplied story beat and opens a local reader without changing stored or external data.",
  codenames: "Validates the supplied words and clue and opens a local game without changing stored or external data.",
  play: "Validates optional game settings and opens a local game without changing stored or external data.",
};

const OPEN_WORLD =
  "Does not publish content, send messages, or modify any external third-party system. The app is a self-contained bundle with no network access.";
const DESTRUCTIVE = "Does not delete, overwrite, revoke access, or perform irreversible actions.";

const submission = {
  $schema: "https://developers.openai.com/apps-sdk/schemas/chatgpt-app-submission.v1.json",
  schema_version: 1,
  app_info: {
    display_name: "Icebox",
    subtitle: "Thirty small things to play",
    description:
      "Icebox opens interactive mini apps and games inside ChatGPT: pick a colour, roll dice, flip a coin, draw a card, spin a wheel, and play Tetris, 2048, Minesweeper, Snake, Wordle, Sudoku, Blackjack and eighteen more. Several games are written by the model as you play, including trivia on any topic you name, a branching adventure, and Codenames with the model as your spymaster.",
    category: "ENTERTAINMENT",
  },
  tools: Object.fromEntries(
    ALL_SPECS.map((spec) => [
      spec.name,
      {
        annotations: {
          readOnlyHint: true,
          openWorldHint: false,
          destructiveHint: false,
        },
        justifications: {
          read_only_justification:
            READ_ONLY[spec.name] ??
            "Validates its own arguments and opens a local app without changing stored or external data.",
          open_world_justification: OPEN_WORLD,
          destructive_justification: DESTRUCTIVE,
        },
      },
    ]),
  ),
};

const missing = ALL_SPECS.filter((s) => !READ_ONLY[s.name]).map((s) => s.name);
if (missing.length) {
  console.warn(`gen-submission: no read-only justification written for: ${missing.join(", ")}`);
  console.warn("A generic line was used. Add a specific one in scripts/gen-submission.mts.");
}

const out = path.join(process.cwd(), "chatgpt-app-submission.json");
await fs.writeFile(out, `${JSON.stringify(submission, null, 2)}\n`, "utf-8");
console.log(`gen-submission: wrote ${ALL_SPECS.length} tool entries`);
