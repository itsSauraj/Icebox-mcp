/**
 * @file Pure color-conversion helpers. HSV + alpha is the source of truth in
 * the UI; RGB/HEX/HSL are derived for display and parsed back on user input.
 */
export type RGB = { r: number; g: number; b: number };
export type HSVA = { h: number; s: number; v: number; a: number };

export const clamp = (n: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n);

export function hsvToRgb(h: number, s: number, v: number): RGB {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0, g = 0, b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = v - c;
  return { r: round((r + m) * 255), g: round((g + m) * 255), b: round((b + m) * 255) };
}

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s, v: max };
}

export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: round(h), s: round(s * 100), l: round(l * 100) };
}

const toHex2 = (n: number) => clamp(round(n), 0, 255).toString(16).padStart(2, "0");

export function rgbToHex({ r, g, b }: RGB, a = 1): string {
  const base = `#${toHex2(r)}${toHex2(g)}${toHex2(b)}`;
  return a >= 1 ? base : base + toHex2(a * 255);
}

/** Parse #rgb, #rgba, #rrggbb, #rrggbbaa. Returns null when invalid. */
export function parseHex(input: string): { rgb: RGB; a: number } | null {
  let h = input.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3,4}$/.test(h)) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(h)) return null;
  const rgb = {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { rgb, a };
}

/** Convert HSVA state into the canonical hex / rgb / hsl display strings. */
export function colorStrings(c: HSVA) {
  const rgb = hsvToRgb(c.h, c.s, c.v);
  const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const a2 = +c.a.toFixed(2);
  return {
    rgb,
    hex: rgbToHex(rgb, c.a),
    rgbStr: c.a >= 1
      ? `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`
      : `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a2})`,
    hslStr: c.a >= 1
      ? `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`
      : `hsla(${hsl.h}, ${hsl.s}%, ${hsl.l}%, ${a2})`,
  };
}

/** Build an HSVA from an RGB, preserving hue for greyscale inputs. */
export function hsvaFromRgb(rgb: RGB, a: number, prevHue: number): HSVA {
  const { h, s, v } = rgbToHsv(rgb.r, rgb.g, rgb.b);
  return { h: s > 0 ? h : prevHue, s, v, a };
}
