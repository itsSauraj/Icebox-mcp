/**
 * @file The arcade: one bundle, eighteen games, one `play` tool.
 *
 * A tool's UI resource is bound when the tool is registered, so a single tool
 * cannot hand the host a different document per game. Everything reached
 * through `play` therefore lives in one bundle and this component decides what
 * to mount: the game named in the tool result, or the picker when none was
 * named.
 *
 * Because every game is already loaded, picking one from the menu is instant
 * and costs no model turn. Games opened from the menu simply receive an empty
 * seed and use their own defaults.
 *
 * Each game is mounted inside an error boundary. Eighteen games sharing a
 * bundle means one crash would otherwise take the whole arcade down with it.
 */
import { Component, useCallback, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { GROUPS } from "../../games/apps.mjs";
import { GameFrame, useFullscreen, useSeed, seedString } from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import { ARCADE_BY_NAME, ARCADE_ENTRIES } from "./games.generated";
import a from "./arcade.module.css";

class GameBoundary extends Component<{ name: string; onBack: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`Arcade game "${this.props.name}" crashed:`, error, info.componentStack);
  }

  componentDidUpdate(prev: { name: string }) {
    if (prev.name !== this.props.name && this.state.failed) this.setState({ failed: false });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className={a.crash}>
        <p className={a.crashTitle}>That game hit a problem</p>
        <p className={a.crashBody}>The rest of the arcade is fine. Pick another and carry on.</p>
        <button className={`${ui.btn} ${ui.primary}`} onClick={this.props.onBack}>
          Back to the arcade
        </button>
      </div>
    );
  }
}

export default function Arcade({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const seed = useSeed(runtime);

  // A game chosen from the picker overrides whatever the tool call named, so
  // the player can move on without asking the model for anything.
  const [chosen, setChosen] = useState<string | null>(null);
  const requested = seedString(seed, "game");
  const active = chosen ?? (requested && ARCADE_BY_NAME[requested] ? requested : null);
  const entry = active ? ARCADE_BY_NAME[active] : undefined;

  const back = useCallback(() => setChosen(null), []);

  if (entry) {
    const Game = entry.Component;
    return (
      <>
        <GameBoundary name={entry.name} onBack={back}>
          <Game runtime={runtime} />
        </GameBoundary>
        <div className={a.backRow}>
          <button className={ui.btn} onClick={back}>
            All games
          </button>
        </div>
      </>
    );
  }

  const sections = GROUPS.map((group) => ({
    group,
    games: ARCADE_ENTRIES.filter((e) => e.group === group),
  })).filter((s) => s.games.length > 0);

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide>
      <header className={a.head}>
        <h1 className={ui.title}>Icebox Arcade</h1>
        <p className={ui.subtitle}>{ARCADE_ENTRIES.length} games. Pick one.</p>
      </header>

      {sections.map((section) => (
        <section key={section.group} className={a.section}>
          <h2 className={a.groupTitle}>{section.group}</h2>
          <div className={a.grid}>
            {section.games.map((game) => (
              <button key={game.name} className={a.card} onClick={() => setChosen(game.name)}>
                <span className={a.cardTitle}>{game.title}</span>
                <span className={a.cardBlurb}>{game.blurb}</span>
              </button>
            ))}
          </div>
        </section>
      ))}

      <div className={ui.controls}>
        <button className={ui.btn} onClick={toggleFull}>
          {isFull ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>
    </GameFrame>
  );
}
