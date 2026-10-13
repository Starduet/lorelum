import { access } from "node:fs/promises";

import { openSqliteConnection } from "../../../persistence/database/connection";
import {
  semanticIndexDatabaseDefinition,
  type SqliteDatabaseDefinition,
} from "../../../persistence/definitions";
import { semanticVectors } from "../../../persistence/schemas/semantic-index";
import { SemanticIndexError } from "../errors";
import {
  SemanticIndexIncompatibleError,
  SemanticIndexNotReadyError,
  SemanticIndexQueryError,
} from "../errors";
import type { SemanticViewKind } from "../projection";
import type { EmbeddingProfile } from "../profile";
import { isCompatibleMetadata, type SemanticIndexMetadata } from "./metadata";
import {
  readSemanticIndexMetadata,
  readSemanticIndexVectors,
  type SemanticIndexConnection,
  type SemanticIndexVector,
  verifySemanticIndexIntegrity,
} from "./database";
import { semanticIndexPaths, type SemanticIndexPaths } from "./paths";

export interface SemanticCandidate {
  readonly practiceId: string;
  readonly contentDigest: string;
  /** Internal score used only for deterministic ordering. */
  readonly similarity: number;
  /** Best local document view observed for diagnostics and later benchmark analysis. */
  readonly bestViewId: string;
  readonly bestViewKind: SemanticViewKind;
  readonly bestViewOrdinal: number;
}

export interface SemanticQueryVector {
  readonly viewId: string;
  readonly vector: Float32Array;
  readonly weight: number;
}

export interface SemanticIndexReader {
  readonly metadata: SemanticIndexMetadata;
  /** Whether at least one Practice remains eligible after the supplied exclusions. */
  hasEligibleVectors(excludedPracticeIds: ReadonlySet<string>): boolean;
  search(
    queryVectors: readonly SemanticQueryVector[],
    excludedPracticeIds: ReadonlySet<string>,
    limit: number,
  ): readonly SemanticCandidate[];
  close(): void;
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Deterministic representation order for the single-view slot rounds. The
 * projection emits `full`, then `task-card`, then `body`; the index read path
 * has no `ORDER BY`, so the reader must re-establish that order itself or the
 * slot rounds would depend on SQLite row order.
 */
const SEMANTIC_VIEW_KIND_ORDER: Readonly<Record<SemanticViewKind, number>> = Object.freeze({
  full: 0,
  "task-card": 1,
  body: 2,
});

function orderPracticeViews(views: readonly SemanticIndexVector[]): readonly SemanticIndexVector[] {
  if (views.length <= 1) return views;
  return Object.freeze(
    [...views].sort(
      (left, right) =>
        SEMANTIC_VIEW_KIND_ORDER[left.viewKind] - SEMANTIC_VIEW_KIND_ORDER[right.viewKind] ||
        left.viewOrdinal - right.viewOrdinal ||
        compareCodeUnits(left.viewId, right.viewId),
    ),
  );
}

function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) {
    throw new SemanticIndexQueryError("Semantic query vector dimensions are invalid");
  }
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index]! * right[index]!;
  if (!Number.isFinite(score)) {
    throw new SemanticIndexQueryError("Semantic similarity is not finite");
  }
  return score;
}

function validateQueryVectors(
  queryVectors: readonly SemanticQueryVector[],
  dimensions: number,
): number {
  if (queryVectors.length === 0) {
    throw new SemanticIndexQueryError("Semantic query has no vector views");
  }
  let totalWeight = 0;
  const viewIds = new Set<string>();
  for (const query of queryVectors) {
    if (
      query.viewId.length === 0 ||
      viewIds.has(query.viewId) ||
      query.vector.length !== dimensions ||
      !Number.isFinite(query.weight) ||
      query.weight < 0
    ) {
      throw new SemanticIndexQueryError("Semantic query vector view is invalid");
    }
    viewIds.add(query.viewId);
    totalWeight += query.weight;
  }
  if (!(totalWeight > 0)) {
    throw new SemanticIndexQueryError("Semantic query vector weights have no positive mass");
  }
  return totalWeight;
}

function readPracticeIds(connection: SemanticIndexConnection): readonly string[] {
  try {
    const rows = connection.orm
      .select({ practiceId: semanticVectors.practiceId })
      .from(semanticVectors)
      .all();
    const ids = new Set<string>();
    for (const row of rows) {
      if (typeof row.practiceId !== "string" || row.practiceId.length === 0) {
        throw new SemanticIndexQueryError("Semantic index Practice ID is invalid");
      }
      ids.add(row.practiceId);
    }
    return Object.freeze([...ids].sort(compareCodeUnits));
  } catch (error) {
    if (error instanceof SemanticIndexQueryError) throw error;
    throw new SemanticIndexQueryError("Cannot read semantic index Practice IDs", { cause: error });
  }
}

function readCandidateRows(
  connection: SemanticIndexConnection,
  metadata: SemanticIndexMetadata,
  queryVectors: readonly SemanticQueryVector[],
  excludedPracticeIds: ReadonlySet<string>,
): SemanticCandidate[] {
  interface PracticeRow extends SemanticPracticeScore {
    readonly practiceId: string;
    readonly contentDigest: string;
  }
  const rows: PracticeRow[] = [];
  for (const practiceId of readPracticeIds(connection)) {
    if (excludedPracticeIds.has(practiceId)) continue;
    const storedViews = readSemanticIndexVectors(connection, practiceId, metadata.dimensions);
    if (storedViews === undefined || storedViews.length === 0) {
      throw new SemanticIndexQueryError("Semantic index Practice has no vector views");
    }
    const views = orderPracticeViews(storedViews);
    const contentDigest = views[0]!.contentDigest;
    if (views.some((view) => view.contentDigest !== contentDigest)) {
      throw new SemanticIndexQueryError("Semantic index views disagree on canonical content");
    }
    rows.push({
      ...scoreSemanticPractice(queryVectors, views, metadata.dimensions),
      practiceId,
      contentDigest,
    });
  }
  const candidates: SemanticCandidate[] = rows.map((row) => ({
    practiceId: row.practiceId,
    contentDigest: row.contentDigest,
    similarity: row.score,
    bestViewId: row.bestViewId,
    bestViewKind: row.bestViewKind,
    bestViewOrdinal: row.bestViewOrdinal,
  }));
  candidates.sort((left, right) => {
    const scoreOrder = right.similarity - left.similarity;
    return scoreOrder === 0 ? compareCodeUnits(left.practiceId, right.practiceId) : scoreOrder;
  });
  return candidates;
}

/**
 * `full` is a rebuild/context anchor, not a scoring shortcut. If it joined the
 * normal maximum it would duplicate every task-card/body signal and let one
 * noisy body paragraph dominate through the full view. It is used only when a
 * Practice has no scorable view at all.
 */
const SCORING_VIEW_KINDS: ReadonlySet<SemanticViewKind> = new Set([
  "task-card",
  "body",
] satisfies SemanticViewKind[]);

function scorableViews(views: readonly SemanticIndexVector[]): readonly SemanticIndexVector[] {
  const scorable = views.filter((view) => SCORING_VIEW_KINDS.has(view.viewKind));
  return scorable.length > 0 ? scorable : views;
}

export const SEMANTIC_BODY_EVIDENCE_MIX = 0.5;

export interface SemanticPracticeScore {
  readonly score: number;
  /** Best local document view across clauses; diagnostics only. */
  readonly bestViewId: string;
  readonly bestViewKind: SemanticViewKind;
  readonly bestViewOrdinal: number;
}

/**
 * One retrieval pass over the whole corpus. For every query clause the
 * Practice-level evidence is a two-part value: best `task-card` applicability
 * plus body fragment evidence, where body evidence blends the best fragment
 * with the mean of all fragments so one local match stays visible without
 * letting extra chunks raise the score linearly. The clause scores are then
 * aggregated by their query-view weights into one weighted mean, so the corpus
 * is ranked a single time and no cross-round rank fusion is involved. A
 * background-only clause still cannot carry a Practice on its own, because the
 * action clause's near-zero cosine is averaged in rather than dropped; no extra
 * weakest-clause term is applied on top, because that also penalized Practices
 * that match the action clause while missing background context. Every term is
 * a cosine, so the path stays language-neutral and never falls back to lexical
 * matching.
 */
export function scoreSemanticPractice(
  queryVectors: readonly SemanticQueryVector[],
  views: readonly SemanticIndexVector[],
  dimensions: number,
): SemanticPracticeScore {
  if (views.length === 0) {
    throw new SemanticIndexQueryError("Semantic index Practice has no vector views");
  }
  validateQueryVectors(queryVectors, dimensions);
  const ordered = orderPracticeViews(views);
  const scoreViews = scorableViews(ordered);
  let bestView = scoreViews[0]!;
  let bestCosine = Number.NEGATIVE_INFINITY;
  let weightedTotal = 0;
  let weightTotal = 0;
  for (const query of queryVectors) {
    let taskCardMaximum = Number.NEGATIVE_INFINITY;
    let bodyMaximum = Number.NEGATIVE_INFINITY;
    let bodySum = 0;
    let bodyCount = 0;
    for (const view of scoreViews) {
      const score = cosine(query.vector, view.vector);
      if (score > bestCosine) {
        bestCosine = score;
        bestView = view;
      }
      if (view.viewKind === "task-card") {
        taskCardMaximum = Math.max(taskCardMaximum, score);
      } else if (view.viewKind === "body") {
        bodyMaximum = Math.max(bodyMaximum, score);
        bodySum += score;
        bodyCount += 1;
      }
    }
    const components: number[] = [];
    if (taskCardMaximum !== Number.NEGATIVE_INFINITY) components.push(taskCardMaximum);
    if (bodyCount > 0) {
      const bodyMean = bodySum / bodyCount;
      components.push(
        (1 - SEMANTIC_BODY_EVIDENCE_MIX) * bodyMean + SEMANTIC_BODY_EVIDENCE_MIX * bodyMaximum,
      );
    }
    const clauseScore =
      components.length === 0
        ? Number.NEGATIVE_INFINITY
        : components.reduce((sum, score) => sum + score, 0) / components.length;
    if (!Number.isFinite(clauseScore)) {
      throw new SemanticIndexQueryError("Semantic query view has no scorable document views");
    }
    weightedTotal += query.weight * clauseScore;
    weightTotal += query.weight;
  }
  return {
    score: weightedTotal / weightTotal,
    bestViewId: bestView.viewId,
    bestViewKind: bestView.viewKind,
    bestViewOrdinal: bestView.viewOrdinal,
  };
}

/** Open one read-only SQLite connection for metadata and all candidate reads. */
export async function openSemanticIndexReader(
  rootPath: string,
  profile: EmbeddingProfile,
): Promise<SemanticIndexReader> {
  return openSemanticIndexReaderAt(semanticIndexPaths(rootPath, profile.profileId), profile);
}

/** Open one complete artifact at a caller-owned cache location. */
export async function openSemanticIndexReaderAt(
  paths: SemanticIndexPaths,
  profile: EmbeddingProfile,
  definition: SqliteDatabaseDefinition<
    typeof semanticIndexDatabaseDefinition.schema
  > = semanticIndexDatabaseDefinition,
): Promise<SemanticIndexReader> {
  const path = paths.active;
  try {
    await access(path);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      throw new SemanticIndexNotReadyError("Semantic index has not been built");
    }
    throw new SemanticIndexQueryError("Cannot access semantic SQLite index", { cause: error });
  }

  let connection: SemanticIndexConnection | undefined;
  try {
    connection = openSqliteConnection(path, definition.schema, {
      readonly: true,
    });
    verifySemanticIndexIntegrity(connection);
    const metadata = readSemanticIndexMetadata(connection);
    if (!isCompatibleMetadata(metadata, profile, metadata.rootBinding)) {
      throw new SemanticIndexIncompatibleError("Semantic index does not match the active Profile");
    }
    const activeConnection = connection;
    return Object.freeze({
      metadata,
      hasEligibleVectors(excludedPracticeIds: ReadonlySet<string>) {
        return readPracticeIds(activeConnection).some(
          (practiceId) => !excludedPracticeIds.has(practiceId),
        );
      },
      search(queryVectors, excludedPracticeIds, limit) {
        if (!Number.isSafeInteger(limit) || limit < 1) {
          throw new SemanticIndexQueryError("Semantic candidate limit is invalid");
        }
        const candidates = readCandidateRows(
          activeConnection,
          metadata,
          queryVectors,
          excludedPracticeIds,
        );
        return Object.freeze(candidates.slice(0, limit));
      },
      close() {
        activeConnection.close();
      },
    } satisfies SemanticIndexReader);
  } catch (error) {
    try {
      connection?.close();
    } catch {
      // Preserve the original index failure.
    }
    if (
      error instanceof SemanticIndexNotReadyError ||
      error instanceof SemanticIndexIncompatibleError ||
      error instanceof SemanticIndexQueryError
    ) {
      throw error;
    }
    if (error instanceof SemanticIndexError) {
      throw new SemanticIndexQueryError(error.message, { cause: error });
    }
    throw new SemanticIndexQueryError("Cannot open semantic SQLite index", { cause: error });
  }
}
