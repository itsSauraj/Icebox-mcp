/**
 * @file Shared inline SVG icons for the app title bars. All use `currentColor`
 * so `.titleIcon` (accent) tints them; sized in `em` to track the title.
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export const ColorPickerIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <path d="M12 3s6 6.5 6 10a6 6 0 0 1-12 0c0-3.5 6-10 6-10z" />
  </svg>
);

export const DiceIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" aria-hidden="true" {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <circle cx="8.5" cy="8.5" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="8.5" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="8.5" cy="15.5" r="1.15" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="15.5" r="1.15" fill="currentColor" stroke="none" />
  </svg>
);

export const CoinIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} aria-hidden="true" {...p}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="5.3" />
  </svg>
);

export const CardIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" aria-hidden="true" {...p}>
    <rect x="5" y="3" width="14" height="18" rx="2.5" />
    <path d="M12 16s-3.6-2.3-3.6-4.7A1.9 1.9 0 0 1 12 9.4a1.9 1.9 0 0 1 3.6 1.9C15.6 13.7 12 16 12 16z" fill="currentColor" stroke="none" />
  </svg>
);

export const WheelIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <circle cx="12" cy="13" r="8" />
    <path d="M12 13V5.5M12 13l6.5 3.8M12 13 5.5 16.8" />
    <path d="M12 2.2l1.9 3.1h-3.8z" fill="currentColor" stroke="none" />
    <circle cx="12" cy="13" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);

export const DecisionIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <rect x="4" y="4" width="16" height="16" rx="3" />
    <path d="M9.6 9.7a2.4 2.4 0 1 1 3.4 2.2c-.8.4-1 .9-1 1.6" />
    <circle cx="12" cy="16.4" r="1" fill="currentColor" stroke="none" />
  </svg>
);

export const WordleIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round" aria-hidden="true" {...p}>
    <rect x="3" y="9" width="5.5" height="5.5" rx="1" />
    <rect x="9.25" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" stroke="none" />
    <rect x="15.5" y="9" width="5.5" height="5.5" rx="1" />
  </svg>
);

export const SnakeIcon = (p: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...p}>
    <path d="M6 18h6a3 3 0 0 0 0-6H9a3 3 0 0 1 0-6h6" />
    <circle cx="17.6" cy="6" r="1.4" fill="currentColor" stroke="none" />
  </svg>
);
