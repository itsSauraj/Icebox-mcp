/**
 * Builds every app bundle.
 *
 * Replaces the old chain of sequential `vite build` calls in package.json. Two
 * reasons: the input list now comes from `games/apps.mjs` rather than a string
 * that has to be edited by hand, and the passes run concurrently. Each pass
 * takes roughly three seconds, so at fifteen bundles the difference is about
 * forty-five seconds against twelve.
 *
 * `dist/` is emptied once here rather than by the first pass, because with
 * concurrent passes there is no reliable "first".
 *
 * Usage:
 *   node scripts/build-apps.mjs              production, all inputs
 *   node scripts/build-apps.mjs --dev        sourcemaps, no minify
 *   node scripts/build-apps.mjs snake.html   just these inputs
 */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BUILD_INPUTS } from "../games/apps.mjs";

const args = process.argv.slice(2);
const dev = args.includes("--dev");
const only = args.filter((a) => !a.startsWith("--"));
const inputs = only.length ? only : BUILD_INPUTS;

// Vite is CPU-bound here. Leave a couple of cores for the OS so an eight-way
// fan-out on a four-core machine does not end up slower than four.
const limit = Math.max(1, Math.min(inputs.length, (os.availableParallelism?.() ?? os.cpus().length) - 2));

const root = process.cwd();
const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");

function buildOne(input) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [viteBin, "build"], {
      cwd: root,
      env: {
        ...process.env,
        INPUT: input,
        NODE_ENV: dev ? "development" : "production",
        // dist/ is cleared up front, so no pass may empty it.
        CLEAN: "0",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ input, out });
      else reject(new Error(`vite build failed for ${input} (exit ${code})\n${out}`));
    });
  });
}

async function run() {
  const started = Date.now();
  // Only a full build owns dist/. A targeted build (`build-apps.mjs snake.html`)
  // must leave the other bundles alone: several people, or several agents, may
  // be verifying different games against the same tree at once, and clearing
  // dist/ here would delete work that is not ours.
  if (!only.length) await fs.rm(path.join(root, "dist"), { recursive: true, force: true });
  await fs.mkdir(path.join(root, "dist"), { recursive: true });

  console.log(`Building ${inputs.length} bundles, ${limit} at a time (${dev ? "development" : "production"})`);

  const queue = [...inputs];
  const failures = [];
  let done = 0;

  const worker = async () => {
    for (;;) {
      const input = queue.shift();
      if (!input) return;
      try {
        await buildOne(input);
        done++;
        console.log(`  [${done}/${inputs.length}] ${input}`);
      } catch (e) {
        failures.push(e);
        console.error(`  FAILED ${input}`);
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, worker));

  if (failures.length) {
    for (const f of failures) console.error(`\n${f.message}`);
    console.error(`\n${failures.length} of ${inputs.length} bundles failed.`);
    process.exit(1);
  }

  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`Built ${inputs.length} bundles in ${secs}s`);
}

await run();
