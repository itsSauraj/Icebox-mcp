# Writing an Icebox game

Read this before touching `src/<game>/`. It is the whole contract.

## What you own, and only this

```
src/<game>/index.tsx          the game
src/<game>/<game>.module.css  its styles
```

Nothing else. Do not edit `server.ts`, `games/registry.ts`, `games/apps.mjs`,
`src/lib/*`, `src/arcade/*`, `package.json`, `vite.config.ts`, or any other
game's folder. Those are already wired for you. If you believe you need a
change there, say so in your report instead of making it: other agents are
editing this tree at the same time and a shared-file edit will collide.

Do not run `git add`, `git commit`, or any other git command. Commits are made
for you, one per game.

## The contract

`src/<game>/index.tsx` exports a default React component taking `AppProps`:

```tsx
import type { AppProps } from "../lib/runtime";

export default function MyGame({ runtime }: AppProps) { ... }
```

That is all. A hero game already has a generated `main.tsx` that mounts it; an
arcade game is mounted by the shared dispatcher. Never call `renderApp`
yourself and never create `main.tsx`.

Your folder already contains a placeholder `index.tsx` marked `ICEBOX-STUB`.
Replace the whole file.

## The shell: `src/lib/game.tsx`

Use these. Do not reimplement them, and do not reach for a timer library, a
state library, or an animation library.

### Loops

```ts
useGameLoop(running: boolean, tickMs: number, onTick: () => void)
```
Fixed timestep. `onTick` fires once per `tickMs` of elapsed time and catches up
after a stall, capped at 10 ticks. For anything that advances in discrete steps:
Tetris gravity, Snake, a turn timer.

```ts
useFrameLoop(running: boolean, onFrame: (dtMs: number) => void)
```
Every animation frame, with elapsed milliseconds clamped to 250. For continuous
motion: a ball, a falling bird, a paddle. **Integrate against `dtMs`.** Never
assume 60fps, or the game runs at a different speed on a 120Hz display.

```ts
const [left, reset] = useCountdown(seconds, running, onExpire)
```
Whole-second countdown for timed games.

Both loops run on `requestAnimationFrame`. Never use `setInterval` for
gameplay: host iframes throttle it and it drifts.

### Input

```ts
useDirectionKeys(onDirection, onPause?, enabled?)   // arrows + WASD, space to pause
useKeys({ z: undo, escape: quit, " ": drop })       // arbitrary keys, lowercased
const swipe = useSwipe(onDirection)                 // spread onto the board element
useTapAnywhere(onTap, enabled?)                     // one-input games
<DPad onDirection={...} hide="vertical" />          // on-screen pad
```

Every game must be playable with **keyboard and touch**. A game that needs a
mouse and nothing else is incomplete: hosts run on phones. Pointer-driven games
(Minesweeper, Aim Trainer) are exempt from the d-pad but must still work on
touch, including a long-press or a mode toggle where a right-click would be.

`useKeys` and `useDirectionKeys` already ignore modifier chords, typing inside
fields, and Space or Enter on a focused button.

### Settings from the tool call

```ts
const seed = useSeed(runtime);
const topic = seedString(seed, "topic", "General knowledge");
const size  = seedNumber(seed, "size", 4, 3, 6);
const words = seedArray<string>(seed, "words");
```

`useSeed` merges the tool input and the tool result into one object, so you read
settings the same way whether your game was opened by its own tool or through
`play`. It starts empty and fills in when the host delivers the notification,
which may be after mount, so **render sensibly with nothing** and react when it
arrives.

Look up what your game receives in `games/registry.ts`. Anything the model sent
has already been cleaned by `games/validate.ts`, but it is still optional:
always have your own fallback content and use it when the seed is empty. Never
show an error because the model sent nothing.

### Chrome

```tsx
const rootRef = useRef<HTMLDivElement>(null);
const [isFull, toggleFull] = useFullscreen(runtime, rootRef);

<GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide>
  <GameHeader title="Tetris" stats={[{ label: "Score", value: score }, { label: "Best", value: best }]} />

  <div className={s.boardWrap}>
    <div className={s.board} {...swipe}>…</div>
    <Overlay status={status} detail={`Score ${score}`} action="Play again" onAction={restart} />
  </div>

  <DPad onDirection={move} />
  <StandardControls status={status} onPause={togglePause} onRestart={restart}
                    fullscreen={isFull} onFullscreen={toggleFull} onShare={share} />
  <StatusLine>{shareStatus}</StatusLine>
</GameFrame>
```

`Overlay` renders nothing while `status === "playing"` and handles ready,
paused, over and won. Give it `position: relative` ancestor: put it inside your
`boardWrap`.

Also available: `Segmented` for difficulty and mode pills, `ControlBar` for a
custom button row, `Notice` for a quiet line of explanation, `Arrow`, `sv` for
CSS custom-property styles, `clamp`, `isTerminal`.

### Score and reporting

```ts
const best = useBest(score);

useGameOverReport(runtime, isTerminal(status), () =>
  `Tetris over. Score ${score}, ${lines} lines, level ${level}.`);

const [shareStatus, share] = useShare(runtime);
// on a button: share(`I scored ${score} in Tetris!`, `Tetris score ${score}.`)
```

`useGameOverReport` fires once per game over and re-arms on restart. It costs no
model turn, so it is the right place for every result. `useShare` does cost a
model turn: wire it to a button only, never to gameplay.

`useBest` is in-memory by design. Do not add `localStorage`.

### Asking the model for more content

A content game that runs out mid-session asks for more through `share`:

```ts
share("Ten more questions on the same topic please.", `Quiz finished: ${score}/${total}.`);
```

Do this only when the player has actually exhausted the material, and only from
a button they pressed.

## Styling

- One CSS module per game: `src/<game>/<game>.module.css`.
- **All colour comes from the host style variables.** Use
  `--color-text-primary`, `--color-text-secondary`, `--color-background-primary`,
  `--color-background-secondary`, `--color-border`, `--color-accent`,
  `--color-text-on-accent`, `--color-ring-primary`, and the `--spacing-*`,
  `--border-radius-*`, `--font-weight-*` tokens from `src/global.css`. The host
  overrides these at runtime, so a hardcoded hex breaks theming.
- A literal colour is acceptable only where the colour **is** the content:
  Tetris piece colours, suit red, Mastermind pegs, a Connect Four disc. Keep
  those in one named map at the top of the file and make sure they stay legible
  on both a light and a dark ground. Everything structural uses tokens.
- `color-mix(in srgb, var(--color-accent) 60%, transparent)` is the house way to
  tint. `light-dark()` is available for the rare literal that needs both.
- Boards get `touch-action: none` and `user-select: none`.
- Size boards in `vmin` or percentages so they fit a narrow iframe and a
  fullscreen tab. Look at `src/snake/snake.module.css` for the pattern:
  `width: min(100%, 78vmin)` on a wrapper with `aspect-ratio`, and grid cells at
  `calc(100% / var(--grid))`.
- Prefer CSS transforms and transitions over per-frame React re-renders for
  motion. Snake moves 60 segments smoothly while re-rendering roughly 8 times a
  second, because each segment CSS-transitions its `transform`.
- Wrap every animation in `@media (prefers-reduced-motion: reduce)` and turn it
  off there.

## Accessibility

- Every control is a real `<button>` with a label. Icon-only buttons get
  `aria-label`.
- Toggle buttons get `aria-pressed`.
- The board gets `role="img"` with a meaningful `aria-label`, or proper grid
  semantics if cells are individually operable.
- A live result gets `role="status" aria-live="polite"` (that is `StatusLine`).
- Focus must stay visible. The shell handles this for its own controls.

## Constraints

- **No new dependencies.** React, the MCP SDK and Zod are all you get. No
  canvas libraries, no animation libraries, no lodash. Plain SVG, CSS and DOM.
- TypeScript is strict, with `noUnusedLocals` and `noUnusedParameters` on. An
  unused import or variable is a build failure.
- The bundle is one self-contained HTML file with **no network access at all**.
  No fetch, no external images, no web fonts, no CDN. Emoji and inline SVG only.
- 18 games share the arcade bundle, so keep your game's own code tight. Roughly
  200 to 500 lines of TSX is the expected range. A game that needs a large word
  list should generate or derive it, not embed thousands of entries.
- Do not use `Math.random()` during initial state construction. React StrictMode
  double-invokes initialisers, so a random initial board differs between the two
  passes. Build a deterministic starting state and randomise on the first tick
  or on the player's first input. `src/snake/index.tsx` shows the pattern.
- Randomness helpers live in `src/lib/rng.ts`: `randInt`, `pick`, `shuffle`.

## Writing style

Match the surrounding code. `src/snake/index.tsx` and `src/wordle/index.tsx` are
the reference: a file-header comment explaining the *approach* and any non-obvious
decision, pure helper functions above the component, comments only where the
reason is not obvious from the code.

**Do not use em dashes anywhere**, in code, comments or UI copy. Use a comma, a
colon, or a full stop.

UI copy is short and concrete. "Play again", not "Click here to play again!".

## Verifying your work

```bash
npx tsc --noEmit 2>&1 | grep "src/<your-game>/"
```

Must print nothing. The project-wide run will show errors from other games being
written at the same time, which are not yours: filter to your own folder.

Then build just your bundle:

```bash
# hero game
node scripts/build-apps.mjs <your-game>.html

# arcade game
node scripts/build-apps.mjs arcade.html
```

Must exit 0. Note that the arcade build compiles all 18 arcade games, so a
failure there may not be yours; check the error path before assuming it is.

## Report back

Say what you built, the controls, what it does with seed data, anything you
deliberately left out, and any shared-file change you think is needed. Keep it
to a short paragraph and a bullet list. Do not paste the source.
