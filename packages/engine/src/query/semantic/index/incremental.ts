import {
  revisionDeltaPracticeIds,
  type EffectivePractice,
  type RevisionDelta,
} from "../../../local-store/model";
import {
  projectSemanticPractice,
  type SemanticDocument,
  type SemanticProjectionView,
} from "../projection";

export interface ReusableSemanticVector {
  readonly viewId: string;
  readonly projectionDigest: string;
  readonly vector: Float32Array;
}

export interface IncrementalSemanticIndexPlan {
  /** Delete all rows touched by the revision interval before inserting final rows. */
  readonly removedPracticeIds: readonly string[];
  /** Final canonical documents that need rows in the updated index. */
  readonly documents: readonly SemanticDocument[];
  /** Only these content views require a new embedding request. */
  readonly viewsToEmbed: readonly SemanticProjectionView[];
  /** Valid unchanged vectors keyed by final Practice ID and view ID. */
  readonly reusableVectors: ReadonlyMap<string, ReadonlyMap<string, Float32Array>>;
}

/** Collapse one or more Store revisions to their final document-level index work. */
export function planIncrementalSemanticIndex(
  deltas: readonly RevisionDelta[],
  practices: readonly EffectivePractice[],
  reusable: (practiceId: string) => readonly ReusableSemanticVector[] | undefined,
): IncrementalSemanticIndexPlan {
  const removedPracticeIds = Object.freeze([...revisionDeltaPracticeIds(deltas, true)].sort());
  const documents = Object.freeze(practices.map(projectSemanticPractice));
  const reusableVectors = new Map<string, ReadonlyMap<string, Float32Array>>();
  const viewsToEmbed: SemanticProjectionView[] = [];
  for (const document of documents) {
    const priorByView = new Map(
      (reusable(document.practiceId) ?? []).map((item) => [item.viewId, item] as const),
    );
    const reusableForPractice = new Map<string, Float32Array>();
    for (const view of document.views) {
      const prior = priorByView.get(view.viewId);
      if (prior?.projectionDigest === view.projectionDigest) {
        reusableForPractice.set(view.viewId, prior.vector);
      } else {
        viewsToEmbed.push(view);
      }
    }
    reusableVectors.set(document.practiceId, reusableForPractice);
  }
  return Object.freeze({
    removedPracticeIds,
    documents,
    viewsToEmbed: Object.freeze(viewsToEmbed),
    reusableVectors,
  });
}
