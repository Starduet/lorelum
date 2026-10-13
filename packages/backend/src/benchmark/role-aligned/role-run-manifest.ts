import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { ExperimentError } from "./experiment-error";
import { artifact, codeIdentity, environment, sha } from "./manifest";

/**
 * Manifest of one G1 run: every condition of one query set, scored over the
 * same corpus, vectors and code. As in G0 it is the only record the scoring
 * phase trusts; a ranking whose manifest is missing, failed or no longer
 * matching its digests is never scored.
 */
export const ROLE_RUN_MANIFEST_VERSION = 1;
export const ROLE_RUN_MANIFEST_FILE = "role-manifest.json";
export const ROLE_RANKING_FORMAT_VERSION = 1;
export const PRACTICE_DIGESTS_FILE = "practice-digests.json";

/**
 * Registered conditions. `control`, `Q` and `Q+I` are the candidates; the rest
 * only attribute: flat weights isolate the weighting, `N-*` isolate extra text
 * and processing budget, `*-restated` isolate the wording of the role text.
 */
export const ROLE_CONDITION_IDS = [
  "control",
  "Q",
  "Q+I",
  "Q-flat",
  "Q+I-flat",
  "N-background",
  "N-segments",
  "Q-restated",
  "Q+I-restated",
  "S",
  "S-dup",
  "F",
] as const;
export type RoleConditionId = (typeof ROLE_CONDITION_IDS)[number];
const conditionId = z.enum(ROLE_CONDITION_IDS);

const count = z.number().int().min(0);
const ms = z.number().min(0);

const conditionRecord = z.strictObject({
  id: conditionId,
  ranking: artifact,
  queryCount: z.number().int().min(1),
  /** Queries scored by the production clause path because no role was scorable. */
  fallbackQueries: count,
  /** Largest number of distinct texts the condition encodes for one query. */
  maxTextsPerQuery: count,
  scoringMsMean: ms,
  scoringMsP95: ms,
});

const roleSet = z.strictObject({
  set: z.enum(["primary", "restated"]),
  sampleCount: z.number().int().min(1),
  analysisVersions: z.array(z.string().min(1)).min(1),
  /** Digest over every sample's query ID and sample digest, in query order. */
  digest: sha,
});

const provenance = z.strictObject({
  /** The annotator saw only query text, never targets, labels or any ranking. */
  independentOfTargets: z.boolean(),
  annotator: z.string().min(1),
  disclosure: z.string().min(1),
});

const completeManifest = z.strictObject({
  manifestVersion: z.literal(ROLE_RUN_MANIFEST_VERSION),
  status: z.literal("complete"),
  experiment: z.strictObject({
    id: z.string().min(1),
    policyId: z.string().min(1),
    policyDigest: sha,
    costBudgetId: z.string().min(1),
    costBudgetDigest: sha,
    /** `development`: the reused v2 set; `pilot`: new tasks frozen before any role result. */
    usage: z.enum(["development", "pilot"]),
    backgroundSentences: z.strictObject({ en: z.string(), zh: z.string() }),
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
    roleSets: z.array(roleSet).min(1),
    roleProvenance: provenance,
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
    vectorIdentity: sha,
  }),
  scoring: z.strictObject({
    resultLimit: z.number().int().min(1),
    reportedRanks: z.array(z.number().int().min(1)).min(1),
    /** Every eligible Practice is ranked; K is applied only when a ranking is read. */
    rankingDepth: z.number().int().min(1),
  }),
  /** Production versus independent recomputation of the control condition. */
  controlComparison: z.strictObject({
    pairCount: z.number().int().min(1),
    maxAbsDelta: z.number().min(0),
    toleranceAbs: z.number().positive(),
    mismatchCount: count,
  }),
  conditions: z.array(conditionRecord).min(1),
  artifacts: z.strictObject({ practiceDigests: artifact }),
  cost: z.strictObject({
    cacheState: z.enum(["absent", "rejected-identity", "rejected-corrupt", "accepted"]),
    distinctTexts: count,
    cachedTexts: count,
    encodeCalls: count,
    encodeMsTotal: ms,
    /** Per-query encode latency summed over the query's texts; null when every text was cached. */
    encodeMsPerQueryP95: ms.nullable(),
    totalMs: ms,
    peakRssBytes: count,
  }),
  environment,
});

const failedManifest = z.strictObject({
  manifestVersion: z.literal(ROLE_RUN_MANIFEST_VERSION),
  status: z.literal("failed"),
  experiment: z.strictObject({ id: z.string().min(1) }),
  code: codeIdentity,
  failure: z.strictObject({ code: z.string().min(1), message: z.string().min(1) }),
});

const manifestSchema = z.union([completeManifest, failedManifest]);

export type CompleteRoleRunManifest = z.infer<typeof completeManifest>;
export type FailedRoleRunManifest = z.infer<typeof failedManifest>;
export type RoleRunManifest = z.infer<typeof manifestSchema>;

export function parseRoleRunManifest(raw: unknown): RoleRunManifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExperimentError(
      "input_corrupt",
      `Role run manifest is invalid: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return parsed.data;
}

export async function readRoleRunManifest(directory: string): Promise<RoleRunManifest> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(directory, ROLE_RUN_MANIFEST_FILE));
  } catch (cause) {
    throw new ExperimentError(
      "input_missing",
      "The run has no role manifest; retrieval did not finish",
      {
        cause,
      },
    );
  }
  try {
    return parseRoleRunManifest(JSON.parse(bytes.toString("utf8")));
  } catch (cause) {
    if (cause instanceof ExperimentError) throw cause;
    throw new ExperimentError("input_corrupt", "The role manifest is not valid JSON", { cause });
  }
}
