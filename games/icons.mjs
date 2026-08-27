/**
 * One 24x24 icon per app, as SVG inner markup.
 *
 * Kept out of `apps.mjs` because that file is the manifest the server and the
 * build read, and it should not carry presentation. Both the landing page and
 * the dev launcher import this instead.
 *
 * House style: stroked outlines on a 24x24 box, `currentColor`, roughly 1.7
 * stroke width, with `fill="currentColor" stroke="none"` on the few solid
 * shapes. The wrapper supplies stroke width and line joins, so an entry only
 * overrides them when a shape needs it.
 */

/** Shared wrapper attributes, so every icon renders consistently. */
export const ICON_ATTRS =
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';

export const ICONS = {
  // ---- The six original mini apps, unchanged from the existing pages ----
  "color-picker": '<path d="M12 3s6 6.5 6 10a6 6 0 0 1-12 0c0-3.5 6-10 6-10z"/>',
  dice:
    '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="8.5" cy="8.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.15" fill="currentColor" stroke="none"/>',
  coin: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.3"/>',
  card:
    '<rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M12 16s-3.6-2.3-3.6-4.7A1.9 1.9 0 0 1 12 9.4a1.9 1.9 0 0 1 3.6 1.9C15.6 13.7 12 16 12 16z" fill="currentColor" stroke="none"/>',
  wheel:
    '<circle cx="12" cy="13" r="8"/><path d="M12 13V5.5M12 13l6.5 3.8M12 13 5.5 16.8"/><path d="M12 2.2l1.9 3.1h-3.8z" fill="currentColor" stroke="none"/><circle cx="12" cy="13" r="1.4" fill="currentColor" stroke="none"/>',
  "decision-dice":
    '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9.6 9.7a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1 .9-1 1.6"/><circle cx="12" cy="16.4" r="1" fill="currentColor" stroke="none"/>',
  wordle:
    '<rect x="3" y="9" width="5.5" height="5.5" rx="1"/><rect x="9.25" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" stroke="none"/><rect x="15.5" y="9" width="5.5" height="5.5" rx="1"/>',
  snake:
    '<path d="M6 18h6a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6" stroke-width="1.9"/><circle cx="17.6" cy="6" r="1.4" fill="currentColor" stroke="none"/>',

  // ---- Hero games ----
  tetris: '<rect x="3.5" y="4" width="7" height="7" rx="1"/><rect x="3.5" y="13" width="7" height="7" rx="1"/><rect x="12.5" y="13" width="7" height="7" rx="1"/>',
  2048: '<rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5" fill="currentColor" stroke="none"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5" fill="currentColor" stroke="none"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.5"/>',
  minesweeper: '<circle cx="12" cy="12" r="5"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  "quiz-duel": '<circle cx="12" cy="12" r="9"/><path d="M9.4 9.3a2.7 2.7 0 1 1 3.8 2.5c-.9.4-1.2 1-1.2 1.8"/><circle cx="12" cy="16.6" r="1.1" fill="currentColor" stroke="none"/>',
  "story-quest": '<path d="M3 5.5A12 12 0 0 1 12 7a12 12 0 0 1 9-1.5v13A12 12 0 0 0 12 20a12 12 0 0 0-9-1.5z"/><path d="M12 7v13"/>',
  codenames: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M9 5v14M15 5v14M3 12h18"/><rect x="9" y="5" width="6" height="7" fill="currentColor" stroke="none" opacity="0.85"/>',

  "music-keyboard": '<rect x="2.5" y="7" width="19" height="11" rx="1.6"/><path d="M7.3 7v7M12 7v7M16.7 7v7"/><rect x="5.4" y="7" width="2.6" height="5" rx="0.6" fill="currentColor" stroke="none"/><rect x="10.1" y="7" width="2.6" height="5" rx="0.6" fill="currentColor" stroke="none"/><rect x="14.8" y="7" width="2.6" height="5" rx="0.6" fill="currentColor" stroke="none"/>',

  // ---- Model writes it ----
  "twenty-questions": '<path d="M20 14.5a2.5 2.5 0 0 1-2.5 2.5H9l-4.5 3.5V6.5A2.5 2.5 0 0 1 7 4h10.5A2.5 2.5 0 0 1 20 6.5z"/><path d="M10.2 8.9a2.2 2.2 0 1 1 3.1 2c-.7.4-.9.8-.9 1.4"/><circle cx="12.4" cy="14.4" r="0.95" fill="currentColor" stroke="none"/>',
  hangman: '<path d="M4 21h9M6 21V3h9v3"/><circle cx="15" cy="8.6" r="2.1"/><path d="M15 10.7v4.3M15 12.4l-2.2 1.6M15 12.4l2.2 1.6M15 15l-1.8 2.6M15 15l1.8 2.6"/>',
  "emoji-riddle": '<circle cx="12" cy="12" r="9"/><path d="M8.6 14.4a4.2 4.2 0 0 0 6.8 0"/><circle cx="9" cy="9.6" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="9.6" r="1.1" fill="currentColor" stroke="none"/>',
  "higher-lower": '<path d="M7.5 20V4M7.5 4 4 7.8M7.5 4l3.5 3.8"/><path d="M16.5 4v16M16.5 20 13 16.2M16.5 20l3.5-3.8"/>',
  "word-search": '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/><path d="M5.6 5.6 18.4 18.4" stroke-width="2.4"/>',

  // ---- Arcade ----
  pacman: '<path d="M12 4a8 8 0 1 0 6.9 12L12 12l6.9-4A8 8 0 0 0 12 4z" fill="currentColor" stroke="none"/><circle cx="20.5" cy="12" r="1.3" fill="currentColor" stroke="none"/>',
  breakout: '<rect x="3.5" y="4" width="5" height="3" rx="0.8" fill="currentColor" stroke="none"/><rect x="9.5" y="4" width="5" height="3" rx="0.8"/><rect x="15.5" y="4" width="5" height="3" rx="0.8" fill="currentColor" stroke="none"/><rect x="6.5" y="9" width="5" height="3" rx="0.8"/><rect x="12.5" y="9" width="5" height="3" rx="0.8" fill="currentColor" stroke="none"/><circle cx="12" cy="15.6" r="1.5" fill="currentColor" stroke="none"/><path d="M8 20h8" stroke-width="2.6"/>',
  balloon: '<path d="M12 3c4 0 7 3 7 6.8 0 3.2-2.6 6-5 8.2h-4c-2.4-2.2-5-5-5-8.2C5 6 8 3 12 3z"/><path d="M12 3v15M6.4 7.5h11.2"/><rect x="10" y="18.6" width="4" height="3" rx="0.8"/>',
  flappy: '<path d="M4 12.5c0-3.6 2.9-6.5 6.5-6.5 3 0 5.5 2 6.3 4.7L21 12l-4.2 1.3A6.5 6.5 0 0 1 4 12.5z"/><path d="M10 12.5c1.6 0 3-1.1 3.4-2.6"/><circle cx="8.2" cy="10.6" r="0.95" fill="currentColor" stroke="none"/>',
  "stack-tower": '<rect x="4" y="16.5" width="16" height="4" rx="1"/><rect x="6" y="11.5" width="12" height="4" rx="1" fill="currentColor" stroke="none"/><rect x="8" y="6.5" width="8" height="4" rx="1"/><path d="M12 4.5V2.5"/>',
  "aim-trainer": '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.2"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><path d="M12 1.5v3.5M12 19v3.5M1.5 12H5M19 12h3.5"/>',

  // ---- Puzzle ----
  sudoku: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-width="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18" stroke-width="1.2"/>',
  nonogram: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18" stroke-width="1.1"/><rect x="9" y="3" width="6" height="6" fill="currentColor" stroke="none"/><rect x="3" y="9" width="6" height="6" fill="currentColor" stroke="none"/><rect x="15" y="15" width="6" height="6" fill="currentColor" stroke="none"/>',
  sokoban: '<rect x="3" y="3" width="18" height="18" rx="2"/><rect x="7.5" y="7.5" width="6" height="6" rx="1" fill="currentColor" stroke="none"/><circle cx="17" cy="17" r="2.4"/><path d="M14.5 10.5h3"/>',
  mastermind: '<circle cx="7.5" cy="7.5" r="3" fill="currentColor" stroke="none"/><circle cx="16.5" cy="7.5" r="3"/><circle cx="7.5" cy="16.5" r="3"/><circle cx="16.5" cy="16.5" r="3" fill="currentColor" stroke="none"/>',

  // ---- Versus ----
  "rock-paper-scissors": '<circle cx="6.5" cy="7" r="3.5"/><path d="M14 4h5l2 2v6h-7z"/><path d="M4 21l6-6M10 21l-6-6" stroke-width="2"/><circle cx="16.5" cy="18.5" r="2.4"/>',
  "connect-four": '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8" cy="9" r="2" fill="currentColor" stroke="none"/><circle cx="16" cy="9" r="2"/><circle cx="8" cy="15" r="2"/><circle cx="16" cy="15" r="2" fill="currentColor" stroke="none"/>',
  "ultimate-ttt": '<path d="M9 3v18M15 3v18M3 9h18M3 15h18"/><path d="M4.6 4.6 7.4 7.4M7.4 4.6 4.6 7.4" stroke-width="2"/><circle cx="19.6" cy="19.6" r="1.7" stroke-width="2"/><path d="M4.6 16.6l2.8 2.8M7.4 16.6l-2.8 2.8" stroke-width="2"/>',
  blackjack: '<rect x="3.5" y="6" width="10" height="14" rx="2" transform="rotate(-9 8.5 13)"/><rect x="11" y="4" width="10" height="14" rx="2" transform="rotate(9 16 11)"/><path d="M16 9.4s-2.2 1.5-2.2 3a1.3 1.3 0 0 0 2.2.9 1.3 1.3 0 0 0 2.2-.9c0-1.5-2.2-3-2.2-3z" fill="currentColor" stroke="none"/>',
  battleship: '<path d="M3 15h18l-2.4 4.2a2 2 0 0 1-1.7 1H7.1a2 2 0 0 1-1.7-1z"/><path d="M6 15V9.5h9L18 15"/><path d="M10.5 9.5V6h4"/><path d="M3 12.2h2M19 12.2h2"/>',
  yahtzee: '<rect x="3" y="8" width="9" height="9" rx="2"/><rect x="12.5" y="4.5" width="8.5" height="8.5" rx="2" transform="rotate(12 16.75 8.75)"/><circle cx="6" cy="11" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="14" r="1" fill="currentColor" stroke="none"/><circle cx="6" cy="14" r="1" fill="currentColor" stroke="none"/><circle cx="9" cy="11" r="1" fill="currentColor" stroke="none"/>',
};

/** Fallback so a new app without an icon still renders something deliberate. */
export const FALLBACK_ICON = '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>';

export const iconFor = (name) => ICONS[name] ?? FALLBACK_ICON;
