// Purple mouse-following spotlight (see body::after in styles.css).
(() => {
  const root = document.documentElement;
  addEventListener(
    "pointermove",
    (e) => {
      root.style.setProperty("--mouse-x", e.clientX + "px");
      root.style.setProperty("--mouse-y", e.clientY + "px");
    },
    { passive: true },
  );
})();
