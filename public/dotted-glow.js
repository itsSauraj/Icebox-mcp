/**
 * Canvas dotted-glow background (vanilla port of the DottedGlowBackground
 * component). Draws a stable grid of dots; each dot has its own phase + speed
 * so they shimmer (glow/dim) organically. Theme-aware, high-DPI, and pauses
 * when off-screen. Renders into the fixed `.fx` layer.
 */
(() => {
  const container = document.querySelector(".fx");
  if (!container) return;

  const canvas = document.createElement("canvas");
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  container.appendChild(canvas);

  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // ---- tunables ----
  const gap = 22;        // distance between dot centers (px)
  const radius = 1.6;    // dot radius (px)
  const opacity = 0.6;   // global layer opacity
  const speedMin = 0.4, speedMax = 1.3, speedScale = 1;

  // ---- theme-aware colors (purple accent) ----
  let dotColor = "rgba(221,183,255,0.85)";
  let glowColor = "rgba(221,183,255,0.9)";
  const prefersDark = () =>
    !window.matchMedia || window.matchMedia("(prefers-color-scheme: dark)").matches;
  const computeColors = () => {
    if (prefersDark()) {
      dotColor = "rgba(221,183,255,0.85)";   // lavender
      glowColor = "rgba(221,183,255,0.9)";
    } else {
      dotColor = "rgba(124,58,237,0.5)";     // deeper purple for light bg
      glowColor = "rgba(124,58,237,0.7)";
    }
  };
  computeColors();
  const mql = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  mql?.addEventListener?.("change", computeColors);

  const dpr = Math.min(Math.max(1, window.devicePixelRatio || 1), 2);
  let dots = [];

  const regen = () => {
    dots = [];
    const { width, height } = container.getBoundingClientRect();
    const cols = Math.ceil(width / gap) + 2;
    const rows = Math.ceil(height / gap) + 2;
    const min = Math.min(speedMin, speedMax);
    const span = Math.max(Math.max(speedMin, speedMax) - min, 0);
    for (let i = -1; i < cols; i++) {
      for (let j = -1; j < rows; j++) {
        const x = i * gap + (j % 2 === 0 ? 0 : gap * 0.5); // offset every other row
        const y = j * gap;
        dots.push({ x, y, phase: Math.random() * Math.PI * 2, speed: min + Math.random() * span });
      }
    }
  };

  const resize = () => {
    const { width, height } = container.getBoundingClientRect();
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.max(1, Math.floor(height * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    regen();
  };

  const paint = (now) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.fillStyle = dotColor;
    const time = (now / 1000) * Math.max(speedScale, 0);
    for (let i = 0; i < dots.length; i++) {
      const d = dots[i];
      const mod = (time * d.speed + d.phase) % 2;
      const lin = mod < 1 ? mod : 2 - mod; // triangle wave 0..1..0
      const a = 0.25 + 0.55 * lin;         // 0.25..0.8
      if (a > 0.6) {
        ctx.shadowColor = glowColor;
        ctx.shadowBlur = 6 * ((a - 0.6) / 0.4);
      } else {
        ctx.shadowColor = "transparent";
        ctx.shadowBlur = 0;
      }
      ctx.globalAlpha = a * opacity;
      ctx.beginPath();
      ctx.arc(d.x, d.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };

  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  // Reduced motion: draw one static frame, no animation.
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    paint(400);
    return;
  }

  let visible = true;
  new IntersectionObserver(
    (entries) => { visible = entries[0]?.isIntersecting ?? true; },
    { threshold: 0.01 },
  ).observe(container);

  const loop = (now) => {
    if (visible) paint(now);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
})();
