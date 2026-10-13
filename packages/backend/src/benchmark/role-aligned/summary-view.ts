import {
  estimatedTokens,
  SEMANTIC_VIEW_MAX_ESTIMATED_TOKENS,
} from "../../../../engine/src/query/semantic/projection";
import { ExperimentError } from "./experiment-error";

/**
 * Experiment-only summary view of a Practice: its own title, `applies_when`,
 * and the `When to apply` and `Why` sections of its body, copied verbatim and
 * joined by blank lines. Nothing is rewritten or generated, and no ids or
 * field labels enter the text, as for the production views. The view never
 * enters the production projection or any index.
 */
export interface SummarySource {
  readonly title: string;
  readonly applies_when: string;
  readonly body?: string | undefined;
}

export const SUMMARY_SECTIONS = ["When to apply", "Why"] as const;

/** Text of a level-2 section, up to the next heading of level 1 or 2; empty when absent. */
export function sectionText(body: string, heading: string): string {
  const lines = body.replace(/\r\n?/gu, "\n").split("\n");
  const collected: string[] = [];
  let inside = false;
  for (const line of lines) {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match !== null) {
      const level = match[1]!.length;
      if (level > 2) continue;
      if (inside) break;
      inside = level === 2 && match[2]!.trim() === heading;
      continue;
    }
    if (inside) collected.push(line);
  }
  return collected.join("\n").trim();
}

/**
 * The summary view texts. Blocks are packed into as few views as the
 * production token budget allows; a single block over budget is a run
 * failure rather than a silent truncation.
 */
export function summaryTexts(source: SummarySource): readonly string[] {
  const blocks = [
    source.title,
    source.applies_when,
    ...SUMMARY_SECTIONS.map((heading) => sectionText(source.body ?? "", heading)),
  ]
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const pieces: string[][] = [[]];
  for (const block of blocks) {
    if (estimatedTokens(block) > SEMANTIC_VIEW_MAX_ESTIMATED_TOKENS) {
      throw new ExperimentError("run_failed", "A summary block exceeds the view token budget");
    }
    const current = pieces[pieces.length - 1]!;
    if (
      current.length > 0 &&
      estimatedTokens([...current, block].join("\n\n")) > SEMANTIC_VIEW_MAX_ESTIMATED_TOKENS
    ) {
      pieces.push([block]);
    } else {
      current.push(block);
    }
  }
  return pieces.filter((piece) => piece.length > 0).map((piece) => piece.join("\n\n"));
}
