/**
 * Types for `games/apps.mjs`. The list itself stays plain ESM so the build
 * scripts can import it from Node without a TypeScript loader.
 */

export type AppKind = "app" | "hero" | "arcade";

export interface AppEntry {
  /** Tool name and `src/` directory name. */
  name: string;
  kind: AppKind;
  /** Human title shown in the UI and the arcade picker. */
  title: string;
  /** One line for the arcade picker. */
  blurb: string;
  /** Picker section. Present on hero and arcade games. */
  group?: string;
}

export declare const ORIGINAL_APPS: AppEntry[];
export declare const HERO_GAMES: AppEntry[];
export declare const ARCADE_GAMES: AppEntry[];
export declare const ALL_GAMES: AppEntry[];
export declare const ALL_APPS: AppEntry[];
export declare const GROUPS: string[];
export declare const BUILD_INPUTS: string[];
export declare const BUNDLED_FILES: string[];
