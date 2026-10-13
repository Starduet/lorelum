import type { EffectivePractice } from "../../local-store";
import { parseQueryRequest } from "../request";
import { assembleQueryHits } from "../result";
import { embedInBatches, type EmbeddingPort } from "./encoding";
import { SemanticIndexQueryError } from "./errors";
import type { SemanticCandidate, SemanticIndexReader } from "./index/reader";
import type { EmbeddingProfile } from "./profile";
import { projectSemanticQuery } from "./query-views";
import type { SemanticQueryResult } from "./query-service";

export interface SemanticArtifactQueryView {
  readonly viewId: string;
  readonly text: string;
  readonly weight: number;
}

/** Execute the source-neutral reader/embedding half of a semantic query. */
export async function searchSemanticArtifact(input: {
  readonly reader: SemanticIndexReader;
  readonly profile: EmbeddingProfile;
  readonly embedding: EmbeddingPort;
  readonly text: string;
  /** Candidate width passed to the reader; not the public 1..50 result limit. */
  readonly candidateLimit: number;
  readonly excludedPracticeIds: ReadonlySet<string>;
  /** Internal experiment seam; default semantic query derives clause views from the request. */
  readonly queryViews?: readonly SemanticArtifactQueryView[];
}): Promise<readonly SemanticCandidate[]> {
  if (!input.reader.hasEligibleVectors(input.excludedPracticeIds)) return Object.freeze([]);
  // Validate and normalize the text through the shared request boundary; the
  // candidate width is an internal ordering width, not the public result limit.
  const text = parseQueryRequest({ text: input.text, limit: 1 }).text;
  const queryViews =
    input.queryViews === undefined || input.queryViews.length === 0
      ? projectSemanticQuery(text)
      : input.queryViews;
  const vectors = await embedInBatches(
    input.profile,
    input.embedding,
    queryViews.map((view) => view.text),
  );
  return input.reader.search(
    queryViews.map((view, index) => {
      const vector = vectors[index];
      if (vector === undefined) {
        throw new SemanticIndexQueryError("Embedding result did not contain a query view vector");
      }
      return { viewId: view.viewId, vector, weight: view.weight };
    }),
    input.excludedPracticeIds,
    input.candidateLimit,
  );
}

/** Assemble a public semantic result from rows already proven current by the caller. */
export function assembleSemanticArtifactResult(input: {
  readonly profile: EmbeddingProfile;
  readonly coverage: SemanticQueryResult["coverage"];
  readonly practices: readonly EffectivePractice[];
  readonly candidates: readonly SemanticCandidate[];
}): SemanticQueryResult {
  return Object.freeze({
    mode: "semantic",
    profileId: input.profile.profileId,
    coverage: input.coverage,
    results: assembleQueryHits(
      input.practices,
      input.candidates,
      (message) => new SemanticIndexQueryError(message),
    ),
  });
}
