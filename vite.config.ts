import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// `command` is "build" for `vite build` and "serve" for the dev server.
export default defineConfig(({ command }) => {
  const INPUT = process.env.INPUT;
  if (command === "build" && !INPUT) {
    throw new Error("INPUT environment variable is not set");
  }

  const isDevelopment = process.env.NODE_ENV === "development";

  return {
    plugins: [react(), viteSingleFile()],
    // `public/` holds the server's base-domain pages (landing/privacy/terms),
    // not Vite assets — disable Vite's publicDir so it isn't copied into dist/
    // or served in place of the dev launcher.
    publicDir: false,
    // Dev server opens the launcher (index.html) listing every app.
    server: {
      open: "/",
    },
    build: {
      sourcemap: isDevelopment ? "inline" : undefined,
      cssMinify: !isDevelopment,
      minify: !isDevelopment,
      rollupOptions: {
        input: INPUT,
      },
      outDir: "dist",
      // Passes run concurrently (scripts/build-apps.mjs), so none of them may
      // empty dist/. The script clears it once before fanning out.
      emptyOutDir: false,
    },
  };
});
