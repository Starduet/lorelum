import { createHash } from "node:crypto";

import { assertEncodingContract, type EncodingContract } from "./encoding";

// v4 restores a token-bounded `full` context anchor and renames the document
// groups to `full` / `task-card` / `body`, dropping the standalone negative
// `topic` axis. v2 and v3 indexes are incompatible and must be rebuilt.
export const SEMANTIC_PROJECTION_VERSION = 4;
// Query projection is versioned independently from document views: splitting a
// request into clause vectors changes retrieval semantics without invalidating
// the persisted Practice representation by itself.
export const SEMANTIC_QUERY_PROJECTION_VERSION = 2;
export const SEMANTIC_NORMALIZATION = "l2" as const;
// Keep the persisted profile shape explicit so any view-recipe change invalidates indexes.
const PERSISTED_DISTANCE_METRIC = "cosine";

export interface EmbeddingProfile extends EncodingContract {
  readonly profileId: string;
  readonly documentProjectionVersion: number;
  readonly normalization: typeof SEMANTIC_NORMALIZATION;
}

/** Create the fixed Profile identity without importing a Backend model implementation. */
export function createEmbeddingProfile(contract: EncodingContract): EmbeddingProfile {
  assertEncodingContract(contract);
  const identity = JSON.stringify({
    encodingId: contract.encodingId,
    dimensions: contract.dimensions,
    documentProjectionVersion: SEMANTIC_PROJECTION_VERSION,
    queryProjectionVersion: SEMANTIC_QUERY_PROJECTION_VERSION,
    normalization: SEMANTIC_NORMALIZATION,
    distanceMetric: PERSISTED_DISTANCE_METRIC,
  });
  return Object.freeze({
    ...contract,
    profileId: createHash("sha256").update(identity).digest("hex"),
    documentProjectionVersion: SEMANTIC_PROJECTION_VERSION,
    normalization: SEMANTIC_NORMALIZATION,
  });
}
