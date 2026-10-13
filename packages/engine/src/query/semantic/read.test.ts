import { expect, test } from "bun:test";
import type { EmbeddingPort } from "./encoding";
import { createEmbeddingProfile } from "./profile";
import { searchSemanticArtifact, type SemanticArtifactQueryView } from "./read";
import type { SemanticIndexReader, SemanticQueryVector } from "./index/reader";

const encodingId = "d".repeat(64);

/** Mirrors the Backend input limit (8) and the query adapter's one-at-a-time admission. */
function queryPort(calls: number[]): EmbeddingPort {
  return {
    maxBatchSize: 1,
    async embed(inputs) {
      calls.push(inputs.length);
      if (inputs.length > 8) throw new Error("embedding.input-invalid");
      return {
        encodingId,
        vectors: inputs.map((text) => {
          const angle = Number(text) / 10;
          return [Math.cos(angle), Math.sin(angle)];
        }),
      };
    },
  };
}

test("a query with more clause views than the input limit still searches, in clause order", async () => {
  const views: SemanticArtifactQueryView[] = Array.from({ length: 9 }, (_, index) => ({
    viewId: `clause-${index}`,
    text: String(index),
    weight: 1,
  }));
  const received: SemanticQueryVector[][] = [];
  // Only the methods searchSemanticArtifact calls are implemented.
  const reader = {
    hasEligibleVectors: () => true,
    search(queryVectors: SemanticQueryVector[]) {
      received.push([...queryVectors]);
      return [];
    },
  } as unknown as SemanticIndexReader;
  const calls: number[] = [];

  await searchSemanticArtifact({
    reader,
    profile: createEmbeddingProfile({ encodingId, dimensions: 2 }),
    embedding: queryPort(calls),
    text: "query",
    candidateLimit: 20,
    excludedPracticeIds: new Set(),
    queryViews: views,
  });

  expect(calls).toEqual(Array(9).fill(1));
  const [searched] = received;
  expect(searched!.map((vector) => vector.viewId)).toEqual(views.map((view) => view.viewId));
  searched!.forEach((vector, index) => {
    expect(vector.vector[0]).toBeCloseTo(Math.cos(index / 10), 5);
  });
});
