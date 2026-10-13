import type { FrozenControlInputs } from "./control-replay";

/**
 * Identity of the frozen development set the G0 control must replay. The query,
 * model and native-manifest digests equal those recorded by the 2026-10-01
 * representation audit, so this run is tied to the same inputs rather than to a
 * path. `nativeManifestSha256` is the win32-x64 runtime manifest.
 *
 * The corpus digest is the engine's content-addressed corpus digest of the 97
 * effective Practices; it was first observed on 2026-10-08 and is pinned here.
 */
export const FROZEN_CONTROL_INPUTS: FrozenControlInputs = Object.freeze({
  suiteRevision: "v2",
  caseCount: 50,
  queriesSha256: "54b621402859e637ee1b92a24dc22e5830b289f3ddd2b9fbfc25f924e5e608f1",
  practiceCount: 97,
  viewCount: 1232,
  corpusDigest: "6d25295b7b4eccc67686fbeb974ddec18a6269a98d5858c36708d1d6b15bb0d1",
  modelSha256: "18e8ce8ce834790618e90d26bed465cca87362076f3042eb0d8eee0732596f59",
  modelBytes: 66_345_216,
  nativeManifestSha256: "3c005a0b25d08e10d5e3398fb2d0532186cd09968f40c8bb8277ea717242de54",
  threads: 4,
  dimensions: 384,
});

/** Result width and candidate width of the frozen scorer, and the ranks every report includes. */
export const FROZEN_SCORER = Object.freeze({
  resultLimit: 5,
  candidateWidth: 20,
  reportedRanks: Object.freeze([1, 3, 5, 20]),
});
