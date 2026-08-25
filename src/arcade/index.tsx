/**
 * @file The arcade: one bundle, eighteen playable games, and the picker that
 * answers "what can I play".
 *
 * A tool's UI resource is bound when the tool is registered, so a single tool
 * cannot hand the host a different document per game. Everything reached
 * through `play` therefore lives in one bundle and this component decides what
 * to mount: the game named in the tool result, or the picker when none was
 * named.
 *
 * The picker deliberately lists **every** app the server can open, not just the
 * eighteen this bundle holds. Someone asking what is available wants the whole
 * answer. The eighteen mount instantly, since they are already loaded and cost
 * no model turn; the rest have their own tools and their own bundles, so
 * choosing one asks the model to open it, which is the only way to swap the
 * host's UI resource.
 *
 * Each game is mounted inside an error boundary. Eighteen games sharing a
 * bundle means one crash would otherwise take the whole arcade down with it.
 */
import { Component, useCallback, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { GROUPS } from "../../games/apps.mjs";
import { GameFrame, useFullscreen, useSeed, seedString, useShare } from "../lib/game";
import type { AppProps } from "../lib/runtime";
import ui from "../lib/ui.module.css";
import { ARCADE_BY_NAME, CATALOGUE, ICON_ATTRS, type CatalogueEntry } from "./games.generated";
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

/**
 * The icon markup is a build-time constant generated from `games/icons.mjs`.
 * It never contains model or user input, which is what makes injecting it safe.
 */
function Icon({ markup }: { markup: string }) {
  return (
    <span
      className={a.cardIcon}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: `<svg ${ICON_ATTRS}>${markup}</svg>` }}
    />
  );
}

/** Section order for the picker, with the model-driven games leading. */
const SECTION_ORDER = [...GROUPS, "Mini apps"];

export default function Arcade({ runtime }: AppProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [isFull, toggleFull] = useFullscreen(runtime, rootRef);
  const [shareStatus, share] = useShare(runtime);
  const seed = useSeed(runtime);

  // A game chosen from the picker overrides whatever the tool call named, so
  // the player can move on without asking the model for anything.
  //
  // Standalone preview has no tool call at all, so it falls back to a `?game=`
  // query parameter. That is what lets the dev launcher link straight to one
  // arcade game instead of dropping every link on the picker.
  const [chosen, setChosen] = useState<string | null>(() => {
    if (!runtime.standalone) return null;
    const wanted = new URLSearchParams(window.location.search).get("game");
    return wanted && ARCADE_BY_NAME[wanted] ? wanted : null;
  });
  const requested = seedString(seed, "game");
  const active = chosen ?? (requested && ARCADE_BY_NAME[requested] ? requested : null);
  const entry = active ? ARCADE_BY_NAME[active] : undefined;

  const back = useCallback(() => setChosen(null), []);

  /** Games that need their own tool are opened by asking the model. */
  const askFor = useCallback(
    (item: CatalogueEntry) => {
      void share(
        `Open ${item.title}.`,
        `Chose ${item.title} from the Icebox picker. It has its own tool, "${item.name}".`,
      );
    },
    [share],
  );

  const sections = useMemo(() => {
    const byGroup = new Map<string, CatalogueEntry[]>();
    for (const item of CATALOGUE) {
      const list = byGroup.get(item.group) ?? [];
      list.push(item);
      byGroup.set(item.group, list);
    }
    return SECTION_ORDER.filter((g) => byGroup.has(g)).map((g) => ({ group: g, items: byGroup.get(g)! }));
  }, []);

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

  return (
    <GameFrame runtime={runtime} innerRef={rootRef} fullscreen={isFull} wide className={a.root}>
      <header className={a.head}>
        <h1 className={ui.title}>Icebox</h1>
        <p className={ui.subtitle}>{CATALOGUE.length} things to play. Pick one.</p>
      </header>

      {sections.map((section) => (
        <section key={section.group} className={a.section}>
          <div className={a.groupHead}>
            <h2 className={a.groupTitle}>{section.group}</h2>
            <span className={a.groupCount}>{section.items.length}</span>
          </div>
          <div className={a.grid}>
            {section.items.map((item) => {
              const instant = item.kind === "arcade";
              return (
                <button
                  key={item.name}
                  className={a.card}
                  onClick={() => (instant ? setChosen(item.name) : askFor(item))}
                  aria-label={`${item.title}. ${item.blurb}.${instant ? "" : " Opens in its own app."}`}
                >
                  <Icon markup={item.icon} />
                  <span className={a.cardTitle}>{item.title}</span>
                  <span className={a.cardBlurb}>{item.blurb}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <div className={ui.controls}>
        <button className={ui.btn} onClick={toggleFull}>
          {isFull ? "Exit fullscreen" : "Fullscreen"}
        </button>
      </div>

      <p className={ui.status} role="status" aria-live="polite">
        {shareStatus}
      </p>
    </GameFrame>
  );
}
