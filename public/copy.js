// Copy-to-clipboard for [data-copy-target] buttons (e.g. the MCP endpoint).
(() => {
  document.querySelectorAll("[data-copy-target]").forEach((btn) => {
    const label = btn.querySelector(".copy-label");
    const original = label ? label.textContent : "";
    let timer;

    btn.addEventListener("click", async () => {
      const sel = btn.getAttribute("data-copy-target");
      const target = sel && document.querySelector(sel);
      const text = target ? (target.textContent || "").trim() : "";
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand("copy"); } catch { /* ignore */ }
        ta.remove();
      }

      btn.classList.add("copied");
      if (label) label.textContent = "Copied!";
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        btn.classList.remove("copied");
        if (label) label.textContent = original;
      }, 1600);
    });
  });
})();
