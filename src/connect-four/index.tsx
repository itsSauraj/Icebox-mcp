/**
 * ICEBOX-STUB
 *
 * Placeholder for Connect Four. Replace this whole file with the real game. It
 * exists so the tree type-checks and the arcade bundle builds while the other
 * games are still being written.
 *
 * Build it against the shared shell in `src/lib/game.tsx`: `useGameLoop` or
 * `useFrameLoop`, `useDirectionKeys`, `useSwipe`, `GameFrame`,
 * `GameHeader`, `Overlay`, `StandardControls`, `useBest`,
 * `useGameOverReport` and `useSeed`.
 */
import { GameHeader, Notice } from "../lib/game";
import type { AppProps } from "../lib/runtime";

export default function ConnectFour({ runtime }: AppProps) {
  return (
    <>
      <GameHeader title="Connect Four" hint={runtime.standalone ? "Standalone preview" : undefined} />
      <Notice>This game has not been built yet.</Notice>
    </>
  );
}
