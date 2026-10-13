import { createHash } from "node:crypto";

import type { EffectivePractice } from "../../local-store";
import { SEMANTIC_PROJECTION_VERSION } from "./profile";

/**
 * Views are cut by an estimated token budget, not by a character count: a
 * character budget silently truncates at the model context about four times
 * sooner for CJK text than for Latin text. The estimate is intentionally
 * conservative because the Engine has no tokenizer of its own.
 */
export const SEMANTIC_VIEW_MAX_ESTIMATED_TOKENS = 384;

/**
 * Representation groups, never lexical field names. `full` keeps the whole
 * Practice as a context anchor for short text, `task-card` is the schema-backed
 * "when does this apply" text, and `body` is the chunked how-to prose. None of
 * them may carry a Practice id, an anti-pattern id, or an English field label:
 * those are lexical anchors rather than task meaning, and they break
 * non-English content. A change here changes the projection recipe and Profile.
 */
export type SemanticViewKind = "full" | "task-card" | "body";

export interface SemanticProjectionView {
  readonly practiceId: string;
  readonly contentDigest: string;
  readonly viewId: string;
  readonly viewKind: SemanticViewKind;
  readonly ordinal: number;
  readonly projectionDigest: string;
  readonly text: string;
}

export interface SemanticDocument {
  readonly practiceId: string;
  readonly contentDigest: string;
  readonly projectionDigest: string;
  readonly views: readonly SemanticProjectionView[];
}

interface MarkdownUnit {
  readonly headingPath: readonly string[];
  readonly text: string;
}

type ProjectionPractice = EffectivePractice["practice"];

const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;

/** Conservative token estimate: CJK ideographs and kana cost about one token each. */
export function estimatedTokens(text: string): number {
  let tokens = 0;
  for (const character of text) tokens += CJK.test(character) ? 1 : 0.25;
  return tokens;
}

function joinNonEmpty(values: readonly string[]): string {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .join("\n\n");
}

function antiPatternTriggers(practice: ProjectionPractice): string {
  return (
    practice.anti_patterns
      // The anti-pattern id is a slug: embedding it would smuggle a lexical anchor in.
      ?.map((antiPattern) => [antiPattern.name, antiPattern.description].join("\n"))
      .join("\n\n") ?? ""
  );
}

/**
 * The schema-backed "when does this apply" text. Field labels and the tech
 * stack are deliberately absent: labels add English scaffolding to non-English
 * content, and domain nouns must not decide an applicability question.
 */
function taskCardText(practice: ProjectionPractice): string {
  return joinNonEmpty([
    practice.title,
    practice.applies_when,
    practice.stage,
    antiPatternTriggers(practice),
  ]);
}

/**
 * The whole Practice as one context anchor, including the tech stack and the
 * full body. It carries no ids or labels; long text is split by token budget so
 * a single over-long input cannot exceed the model context.
 */
function fullText(practice: ProjectionPractice): string {
  return joinNonEmpty([
    practice.title,
    practice.applies_when,
    practice.stage,
    practice.tech_stack.map((entry) => entry.trim()).join(", "),
    antiPatternTriggers(practice),
    practice.body ?? "",
  ]);
}

function markdownUnits(body: string): readonly MarkdownUnit[] {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const headingPath: string[] = [];
  const current: string[] = [];
  const units: MarkdownUnit[] = [];
  const flush = () => {
    const text = current.join("\n").trim();
    current.length = 0;
    if (text.length > 0) units.push(Object.freeze({ headingPath: [...headingPath], text }));
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      flush();
      const level = heading[1]!.length;
      headingPath.splice(level - 1);
      headingPath.push(heading[2]!.trim());
      continue;
    }
    if (line.trim().length === 0) {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return Object.freeze(units);
}

function hardSplit(text: string, maximum: number): readonly string[] {
  const chunks: string[] = [];
  let buffer = "";
  for (const character of text) {
    if (buffer.trim().length > 0 && estimatedTokens(`${buffer}${character}`) > maximum) {
      chunks.push(buffer.trim());
      buffer = "";
    }
    buffer += character;
  }
  if (buffer.trim().length > 0) chunks.push(buffer.trim());
  return Object.freeze(chunks);
}

function splitByTokenBudget(text: string, maximum: number): readonly string[] {
  const whole = text.trim();
  if (estimatedTokens(whole) <= maximum) {
    return Object.freeze(whole.length > 0 ? [whole] : []);
  }
  // CJK sentences end with their own punctuation and need no trailing whitespace.
  const sentences = text
    .split(/(?<=[.!?\u3002\uFF01\uFF1F])/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    const value = current.trim();
    current = "";
    if (value.length > 0) chunks.push(value);
  };

  for (const sentence of sentences) {
    if (estimatedTokens(sentence) > maximum) {
      push();
      chunks.push(...hardSplit(sentence, maximum));
      continue;
    }
    const next = current.length === 0 ? sentence : `${current} ${sentence}`;
    if (estimatedTokens(next) > maximum) {
      push();
      current = sentence;
    } else {
      current = next;
    }
  }
  push();
  return Object.freeze(chunks);
}

function bodyChunkTexts(body: string): readonly string[] {
  const chunks: string[] = [];
  for (const unit of markdownUnits(body)) {
    const heading = unit.headingPath.length === 0 ? "" : `${unit.headingPath.join(" > ")}\n\n`;
    for (const part of splitByTokenBudget(unit.text, SEMANTIC_VIEW_MAX_ESTIMATED_TOKENS)) {
      chunks.push(`${heading}${part}`);
    }
  }
  return Object.freeze(chunks);
}

function viewDigest(input: {
  readonly viewId: string;
  readonly viewKind: SemanticViewKind;
  readonly text: string;
}): string {
  return createHash("sha256")
    .update(
      [SEMANTIC_PROJECTION_VERSION, input.viewKind, input.viewId, input.text].join("\n"),
      "utf8",
    )
    .digest("hex");
}

function projectionView(input: {
  readonly effective: EffectivePractice;
  readonly viewId: string;
  readonly viewKind: SemanticViewKind;
  readonly ordinal: number;
  readonly text: string;
}): SemanticProjectionView {
  return Object.freeze({
    practiceId: input.effective.practiceId,
    contentDigest: input.effective.contentDigest,
    viewId: input.viewId,
    viewKind: input.viewKind,
    ordinal: input.ordinal,
    projectionDigest: viewDigest(input),
    text: input.text,
  });
}

/**
 * Deterministic representation-group projection. The Store remains canonical;
 * this is derived state that a Profile/index version change can rebuild.
 */
export function projectSemanticPractice(effective: EffectivePractice): SemanticDocument {
  const views: SemanticProjectionView[] = [];
  const add = (kind: SemanticViewKind, texts: readonly string[]): void => {
    for (const [ordinal, text] of texts.entries()) {
      views.push(
        projectionView({
          effective,
          viewId: `${kind}:${ordinal.toString().padStart(4, "0")}`,
          viewKind: kind,
          ordinal,
          text,
        }),
      );
    }
  };
  add("full", splitByTokenBudget(fullText(effective.practice), SEMANTIC_VIEW_MAX_ESTIMATED_TOKENS));
  add(
    "task-card",
    splitByTokenBudget(taskCardText(effective.practice), SEMANTIC_VIEW_MAX_ESTIMATED_TOKENS),
  );
  add("body", bodyChunkTexts(effective.practice.body ?? ""));
  const frozenViews = Object.freeze(views);
  const projectionDigest = createHash("sha256")
    .update(
      [
        SEMANTIC_PROJECTION_VERSION,
        ...frozenViews.flatMap((view) => [view.viewId, view.viewKind, view.projectionDigest]),
      ].join("\n"),
      "utf8",
    )
    .digest("hex");
  return Object.freeze({
    practiceId: effective.practiceId,
    contentDigest: effective.contentDigest,
    projectionDigest,
    views: frozenViews,
  });
}
