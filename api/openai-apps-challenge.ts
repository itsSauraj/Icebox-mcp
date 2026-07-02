/**
 * OpenAI Apps domain-verification challenge.
 *
 * Served at /.well-known/openai-apps-challenge (see the rewrite in vercel.json).
 * Returns the challenge token from the OPEN_AI_APP_CHALLANGE environment
 * variable as plain text so OpenAI can verify domain ownership.
 */
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default function handler(_req: VercelRequest, res: VercelResponse) {
  const challenge =
    process.env.OPEN_AI_APP_CHALLANGE ?? process.env.OPENAI_APPS_CHALLENGE ?? "";

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.status(challenge ? 200 : 404).send(challenge);
}
