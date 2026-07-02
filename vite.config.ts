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
      // Each app is built in its own pass; the first pass (CLEAN=1) wipes dist,
      // the rest append their single-file HTML.
      emptyOutDir: process.env.CLEAN === "1",
    },
  };
});
