/**
 * SVG background beams (vanilla port of the BackgroundBeams component). Fifty
 * curved beams, each stroked with a gradient that sweeps along it, so a
 * lavender-to-purple comet travels the curve on its own clock.
 *
 * The fifty paths in the original are one curve repeated: beam i is beam 0
 * shifted +7 across and -8 up. Generating them from that rule beats pasting
 * fifty near-identical 60-character strings, and the faint backdrop line is
 * the same family run a little longer.
 *
 * The sweep is declarative — SVG <animate> on the gradient coordinates — so
 * there is no per-frame JS to run. Renders into the fixed `.fx` layer, and is
 * the landing page's background in place of dotted-glow.js.
 *
 * Stop colours live in styles.css, keyed off the classes below, because a
 * presentation attribute does not resolve var(): `stop-color="var(--accent)"`
 * is invalid and silently falls back to black, which on the navy background
 * looks exactly like a broken script.
 */
(() => {
  const container = document.querySelector(".fx");
  if (!container) return;

  // ---- tunables ----
  const beamCount = 50;      // animated beams
  const backdropCount = 58;  // faint static lines behind them
  const durMin = 10, durMax = 20;  // seconds for one sweep
  const delayMax = 10;             // stagger, so beams never fire in lockstep

  const reduced =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Animated, roughly six of the fifty beams are lit at any moment. Parked,
  // all fifty are — so the still version has to be far fainter to land at a
  // similar weight instead of turning the page into wallpaper.
  const stroke = reduced
    ? 'stroke-opacity="0.14" stroke-width="0.6"'
    : 'stroke-opacity="0.7" stroke-width="0.9"';

  /** Beam i: beam 0 shifted +7 in x, -8 in y. */
  const beamPath = (i) => {
    const x = 7 * i, y = -8 * i;
    return `M${-380 + x} ${-189 + y}C${-380 + x} ${-189 + y} ${-312 + x} ${216 + y} ${152 + x} ${343 + y}` +
      `C${616 + x} ${470 + y} ${684 + x} ${875 + y} ${684 + x} ${875 + y}`;
  };

  // easeInOut as an <animate> spline.
  const ease = 'calcMode="spline" keyTimes="0;1" keySplines="0.42 0 0.58 1"';
  const sweep = (attr, to, dur, delay) =>
    `<animate attributeName="${attr}" values="0%;${to}" dur="${dur}s" begin="${delay}s"` +
    ` repeatCount="indefinite" ${ease}/>`;

  const rand = (min, max) => (min + Math.random() * (max - min)).toFixed(2);

  let defs = "";
  let beams = "";
  for (let i = 0; i < beamCount; i++) {
    const dur = rand(durMin, durMax);
    const delay = rand(0, delayMax);
    // Every beam ends its sweep at a slightly different angle, which is what
    // stops fifty identical curves from reading as one solid sheet.
    const y2 = rand(93, 101) + "%";
    // Unanimated, all four coordinates sit at 0% and the gradient collapses to
    // its last stop (transparent), so a reduced-motion visitor would get a
    // blank layer. Park the gradient along the beam instead.
    const parked = reduced ? ' x1="0%" y1="0%" x2="100%" y2="100%"' : "";

    defs +=
      `<linearGradient id="beam-${i}"${parked}>` +
      (reduced
        ? ""
        : sweep("x1", "100%", dur, delay) +
          sweep("x2", "95%", dur, delay) +
          sweep("y1", "100%", dur, delay) +
          sweep("y2", y2, dur, delay)) +
      '<stop class="beam-lead" stop-opacity="0"/>' +
      '<stop class="beam-lead"/>' +
      '<stop class="beam-mid" offset="32.5%"/>' +
      '<stop class="beam-tail" offset="100%" stop-opacity="0"/>' +
      "</linearGradient>";

    beams += `<path d="${beamPath(i)}" stroke="url(#beam-${i})" ${stroke}/>`;
  }

  let backdrop = "";
  for (let i = 0; i < backdropCount; i++) backdrop += beamPath(i);

  container.insertAdjacentHTML(
    "beforeend",
    '<svg class="beams" viewBox="0 0 696 316" fill="none" aria-hidden="true">' +
      `<path d="${backdrop}" stroke="url(#beam-backdrop)" stroke-opacity="0.09" stroke-width="0.7"/>` +
      beams +
      `<defs>${defs}` +
      '<radialGradient id="beam-backdrop" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse"' +
      ' gradientTransform="translate(352 34) rotate(90) scale(555 1560.62)">' +
      '<stop class="beam-backdrop" offset="0.0666667"/>' +
      '<stop class="beam-backdrop" offset="0.243243"/>' +
      '<stop class="beam-backdrop" offset="0.43594" stop-opacity="0"/>' +
      "</radialGradient>" +
      "</defs>" +
      "</svg>",
  );
})();
