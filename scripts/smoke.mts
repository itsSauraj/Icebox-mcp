/** Quick check that every tool registers and every UI resource loads. */
import { ALL_SPECS } from "../games/registry.js";
import { loadHtml } from "../generated/html/index.js";
import { createServer } from "../server.js";

const server = createServer();
console.log(`tools registered: ${ALL_SPECS.length}`);
console.log(ALL_SPECS.map((s) => s.name).join(", "));

for (const spec of ALL_SPECS) {
  const html = await loadHtml(spec.file);
  if (!html.includes("<div id=\"root\">")) throw new Error(`${spec.file} has no root element`);
  const out = spec.run({});
  if (!out.text) throw new Error(`${spec.name} returned no text`);
  const parsed = spec.outputSchema.safeParse(out.data);
  if (!parsed.success) throw new Error(`${spec.name} output failed its own schema: ${parsed.error.message}`);
}
console.log("all specs: html loads, handler runs, output matches schema");
await server.close();
