import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { digestJson, sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";

/**
 * Run manifest of one isolated experiment condition. It is the only record the
 * scoring phase trusts: a ranking without a complete manifest whose digests
 * match is not scored. Paths are repository-relative or absent so a manifest
 * stays comparable across machines; local paths live in a separate local file.
 */
export const RUN_MANIFEST_VERSION = 1;

export const sha = z.string().regex(/^[a-f0-9]{64}$/);
const fileIdentity = z.strictObject({ path: z.string().min(1), sha256: sha });
export const artifact = z.strictObject({
  file: z.string().min(1),
  sha256: sha,
  bytes: z.number().int().min(0),
});

export const codeIdentity = z.strictObject({
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  /** True when any listed file differs from the commit; the digests below always describe the working tree. */
  listedFilesDirty: z.boolean(),
  files: z.array(fileIdentity).min(1),
  digest: sha,
});

const comparison = z.strictObject({
  pairCount: z.number().int().min(0),
  maxAbsDelta: z.number().min(0),
  toleranceAbs: z.number().positive(),
  mismatchCount: z.number().int().min(0),
  rankOrderIdentical: z.boolean(),
});

const phaseMilliseconds = z.strictObject({
  inputVerification: z.number().min(0),
  corpusRead: z.number().min(0),
  projection: z.number().min(0),
  cacheLoad: z.number().min(0),
  cacheWrite: z.number().min(0),
  runtimeStart: z.number().min(0),
  encode: z.number().min(0),
  productionScoring: z.number().min(0),
  independentScoring: z.number().min(0),
  ranking: z.number().min(0),
  artifactWrite: z.number().min(0),
  total: z.number().min(0),
});

const cost = z.strictObject({
  /** Cold: nothing was reusable and every text was encoded. Warm: the vector cache covered every text. */
  condition: z.enum(["cold-no-vector-cache", "partial-vector-cache", "warm-vector-cache"]),
  milliseconds: phaseMilliseconds,
  encode: z.strictObject({
    distinctTexts: z.number().int().min(0),
    cachedTexts: z.number().int().min(0),
    calls: z.number().int().min(0),
    /** Calls permitted before the run started; exceeding it is a run failure. */
    budgetMaxCalls: z.number().int().min(0),
    /** What happened to a pre-existing vector cache; anything but `accepted` re-encodes the missing texts. */
    cacheState: z.enum(["absent", "rejected-identity", "rejected-corrupt", "accepted"]),
  }),
  io: z.strictObject({
    cacheBytesRead: z.number().int().min(0),
    cacheBytesWritten: z.number().int().min(0),
    artifactBytesWritten: z.number().int().min(0),
  }),
  /** Peak resident set of this process only; the native embedding process is measured externally. */
  peakRssBytes: z.number().int().min(0),
});

export const environment = z.strictObject({
  platform: z.string(),
  arch: z.string(),
  bun: z.string(),
  cpuModel: z.string(),
  cpuCount: z.number().int().min(1),
  totalMemoryBytes: z.number().int().min(1),
});

const failure = z.strictObject({ code: z.string().min(1), message: z.string().min(1) });

const completeManifest = z.strictObject({
  manifestVersion: z.literal(RUN_MANIFEST_VERSION),
  status: z.literal("complete"),
  experiment: z.strictObject({
    id: z.string().min(1),
    condition: z.literal("control"),
    policyId: z.string().min(1),
    policyDigest: sha,
    costBudgetId: z.string().min(1),
    costBudgetDigest: sha,
  }),
  code: codeIdentity,
  inputs: z.strictObject({
    queries: z.strictObject({
      revision: z.string().min(1),
      caseCount: z.number().int().min(1),
      sha256: sha,
    }),
    corpus: z.strictObject({
      digest: sha,
      snapshotIdentity: z.record(z.string(), z.unknown()),
      practiceCount: z.number().int().min(1),
      viewCount: z.number().int().min(1),
    }),
    model: z.strictObject({ sha256: sha, bytes: z.number().int().min(1) }),
    nativeManifestSha256: sha,
  }),
  encoding: z.strictObject({
    encodingId: z.string().min(1),
    profileId: sha,
    pooling: z.string().min(1),
    normalization: z.literal("l2"),
    threads: z.number().int().min(1),
    dimensions: z.number().int().min(1),
  }),
  projection: z.strictObject({
    documentVersion: z.number().int().min(1),
    queryVersion: z.number().int().min(1),
    /** Identity under which cached vectors are reusable; any mismatch forces re-encoding. */
    vectorIdentity: sha,
  }),
  scoring: z.strictObject({
    formula: z.string().min(1),
    resultLimit: z.number().int().min(1),
    candidateWidth: z.number().int().min(1),
    reportedRanks: z.array(z.number().int().min(1)).min(1),
    /** Every eligible Practice is scored and ranked; K is applied only when reading the ranking. */
    rankingDepth: z.number().int().min(1),
  }),
  comparison: comparison.refine((value) => value.mismatchCount === 0 && value.rankOrderIdentical),
  artifacts: z.strictObject({ ranking: artifact, comparison: artifact }),
  cost,
  environment,
});

const failedManifest = z.strictObject({
  manifestVersion: z.literal(RUN_MANIFEST_VERSION),
  status: z.literal("failed"),
  experiment: z.strictObject({ id: z.string().min(1), condition: z.literal("control") }),
  code: codeIdentity,
  failure,
  /** Kept for diagnosis when the failure is a score mismatch; never scored. */
  comparison: comparison.optional(),
  artifacts: z.strictObject({ ranking: artifact, comparison: artifact }).optional(),
});

const manifestSchema = z.union([completeManifest, failedManifest]);

export type CompleteRunManifest = z.infer<typeof completeManifest>;
export type FailedRunManifest = z.infer<typeof failedManifest>;
export type RunManifest = z.infer<typeof manifestSchema>;
export type CodeIdentity = z.infer<typeof codeIdentity>;
export type RunCost = z.infer<typeof cost>;
export type RunEnvironment = z.infer<typeof environment>;
export type ArtifactIdentity = z.infer<typeof artifact>;

export const RUN_MANIFEST_FILE = "manifest.json";

export function parseRunManifest(raw: unknown): RunManifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExperimentError(
      "input_corrupt",
      `Run manifest is invalid: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export function manifestDigest(manifest: RunManifest): string {
  return digestJson(manifest);
}

/** Version control state that a code identity needs; injected so tests need no repository. */
export interface GitProbe {
  head(): Promise<string>;
  /** Whether any of the repository-relative files differs from HEAD or is untracked. */
  dirty(files: readonly string[]): Promise<boolean>;
}

/**
 * Commit plus the digest of every listed working-tree file. HEAD alone would
 * hide the uncommitted changes this experiment runs against.
 */
export async function readCodeIdentity(
  repoRoot: string,
  relativeFiles: readonly string[],
  git: GitProbe,
): Promise<CodeIdentity> {
  const files = await Promise.all(
    [...new Set(relativeFiles)].sort().map(async (path) => {
      try {
        return { path, sha256: sha256Hex(await readFile(join(repoRoot, path))) };
      } catch (error) {
        throw new ExperimentError("input_missing", `Code file ${path} cannot be read`, {
          cause: error,
        });
      }
    }),
  );
  return {
    commit: await git.head(),
    listedFilesDirty: await git.dirty(files.map((file) => file.path)),
    files,
    digest: digestJson(files),
  };
}

/** Re-hash an artifact written by a run and refuse it if it is missing or changed. */
export async function verifyArtifact(
  directory: string,
  expected: ArtifactIdentity,
): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(join(directory, expected.file));
  } catch (error) {
    throw new ExperimentError("input_missing", `Artifact ${expected.file} is missing`, {
      cause: error,
    });
  }
  if (bytes.byteLength !== expected.bytes || sha256Hex(bytes) !== expected.sha256) {
    throw new ExperimentError(
      "input_corrupt",
      `Artifact ${expected.file} does not match its manifest digest`,
    );
  }
  return bytes;
}

export const RANKING_FILE = "ranking.json";
export const COMPARISON_FILE = "score-comparison.json";
export const RANKING_FORMAT_VERSION = 1;
