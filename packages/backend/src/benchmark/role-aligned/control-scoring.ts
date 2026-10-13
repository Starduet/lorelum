import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { compareScoredPractices } from "./candidate-policy";
import { sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";
import {
  manifestDigest,
  parseRunManifest,
  RANKING_FORMAT_VERSION,
  RUN_MANIFEST_FILE,
  verifyArtifact,
  type CompleteRunManifest,
} from "./manifest";

export const SCORE_FILE = "control-score.json";

/**
 * Metrics the frozen control must reproduce (verification sections 20-22).
 * `mrr` is recorded to four decimals in the freeze, so it is compared at that
 * resolution; every count is exact.
 */
export interface ControlBaseline {
  readonly hitAt1: number;
  readonly hitAt3: number;
  readonly hitAt5: number;
  readonly hitAt20: number;
  readonly mrr: number;
  readonly scopeErrorCases: number;
  readonly forbiddenBeforeCoreCases: number;
}

export const FROZEN_CONTROL_BASELINE: ControlBaseline = Object.freeze({
  hitAt1: 33,
  hitAt3: 43,
  hitAt5: 45,
  hitAt20: 47,
  mrr: 0.7637,
  scopeErrorCases: 2,
  forbiddenBeforeCoreCases: 1,
});

const labelsSchema = z.object({
  revision: z.string().min(1),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      coreIds: z.array(z.string().min(1)).min(1),
      forbiddenIds: z.array(z.string().min(1)),
    }),
  ),
});

const rankingSchema = z.strictObject({
  rankingFormatVersion: z.literal(RANKING_FORMAT_VERSION),
  condition: z.literal("control"),
  cases: z.array(
    z.strictObject({
      queryId: z.string().min(1),
      queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
      clauseCount: z.number().int().min(1),
      ranked: z.array(
        z.strictObject({
          practiceId: z.string().min(1),
          score: z.number().finite(),
          rank: z.number().int().min(1),
        }),
      ),
    }),
  ),
});

export interface VerifiedRanking {
  readonly manifest: CompleteRunManifest;
  readonly manifestDigest: string;
  readonly rankingSha256: string;
  /** Practice IDs in rank order, per query. */
  readonly rankedIds: ReadonlyMap<string, readonly string[]>;
}

/**
 * Stage gate between retrieval and labels. A ranking is usable only when its
 * manifest is complete, both artifacts still match their digests, and the
 * ranking is a full, ordered, duplicate-free ordering of the corpus.
 */
export async function readVerifiedRanking(directory: string): Promise<VerifiedRanking> {
  let manifestBytes: Buffer;
  try {
    manifestBytes = await readFile(join(directory, RUN_MANIFEST_FILE));
  } catch (cause) {
    throw new ExperimentError(
      "input_missing",
      "The run has no manifest; retrieval did not finish",
      {
        cause,
      },
    );
  }
  let manifest;
  try {
    manifest = parseRunManifest(JSON.parse(manifestBytes.toString("utf8")));
  } catch (cause) {
    if (cause instanceof ExperimentError) throw cause;
    throw new ExperimentError("input_corrupt", "The run manifest is not valid JSON", { cause });
  }
  if (manifest.status !== "complete") {
    throw new ExperimentError(
      "stage_violation",
      `The run ended as ${manifest.status} (${manifest.failure.code}); its ranking must not be scored`,
    );
  }
  const rankingBytes = await verifyArtifact(directory, manifest.artifacts.ranking);
  await verifyArtifact(directory, manifest.artifacts.comparison);

  let ranking: z.infer<typeof rankingSchema>;
  try {
    ranking = rankingSchema.parse(JSON.parse(Buffer.from(rankingBytes).toString("utf8")));
  } catch (cause) {
    throw new ExperimentError("input_corrupt", "The ranking artifact is not valid", { cause });
  }
  if (ranking.cases.length !== manifest.inputs.queries.caseCount) {
    throw new ExperimentError("input_corrupt", "The ranking does not cover every query");
  }
  const rankedIds = new Map<string, readonly string[]>();
  for (const entry of ranking.cases) {
    if (rankedIds.has(entry.queryId)) {
      throw new ExperimentError("input_corrupt", `The ranking repeats ${entry.queryId}`);
    }
    const ids = entry.ranked.map((item) => item.practiceId);
    if (
      entry.ranked.length !== manifest.scoring.rankingDepth ||
      new Set(ids).size !== ids.length ||
      entry.ranked.some((item, index) => item.rank !== index + 1) ||
      entry.ranked.some(
        (item, index) =>
          index > 0 &&
          compareScoredPractices(
            {
              practiceId: entry.ranked[index - 1]!.practiceId,
              score: entry.ranked[index - 1]!.score,
            },
            { practiceId: item.practiceId, score: item.score },
          ) > 0,
      )
    ) {
      throw new ExperimentError(
        "input_corrupt",
        `The ranking for ${entry.queryId} is not a full ordered list of the corpus`,
      );
    }
    rankedIds.set(entry.queryId, ids);
  }
  return {
    manifest,
    manifestDigest: manifestDigest(manifest),
    rankingSha256: manifest.artifacts.ranking.sha256,
    rankedIds,
  };
}

export interface ControlCaseScore {
  readonly queryId: string;
  /** Rank of the worst-ranked core Practice, the rank at which every core is present. */
  readonly coreRank: number;
  readonly forbiddenRanks: readonly number[];
  readonly scopeError: boolean;
  readonly forbiddenBeforeCore: boolean;
}

export interface ControlScoreReport {
  readonly scoreFormatVersion: 1;
  readonly manifestDigest: string;
  readonly rankingSha256: string;
  readonly labelsSha256: string;
  readonly labelsRevision: string;
  readonly resultLimit: number;
  readonly metrics: {
    readonly caseCount: number;
    readonly hitAt: Readonly<Record<string, number>>;
    readonly mrr: number;
    readonly scopeErrorCases: number;
    readonly forbiddenBeforeCoreCases: number;
  };
  readonly baseline: {
    readonly expected: ControlBaseline;
    readonly reproduced: boolean;
    readonly differences: readonly string[];
  };
  readonly cases: readonly ControlCaseScore[];
}

export interface ControlScoringDeps {
  /** The only place labels are read; it runs after the ranking has been verified. */
  readLabels(): Promise<Uint8Array>;
}

function rankOf(ids: readonly string[], target: string, queryId: string): number {
  const index = ids.indexOf(target);
  if (index < 0) {
    throw new ExperimentError(
      "protocol_invalid",
      `Label for ${queryId} names a Practice that is not in the corpus ranking`,
    );
  }
  return index + 1;
}

/**
 * Label phase. Labels must describe exactly the ranked queries and corpus; any
 * disagreement is a protocol error, never a relevance miss.
 */
export async function scoreControlRun(
  directory: string,
  deps: ControlScoringDeps,
  expected: ControlBaseline = FROZEN_CONTROL_BASELINE,
): Promise<ControlScoreReport> {
  const verified = await readVerifiedRanking(directory);
  const labelsBytes = await deps.readLabels();
  let labels: z.infer<typeof labelsSchema>;
  try {
    labels = labelsSchema.parse(JSON.parse(Buffer.from(labelsBytes).toString("utf8")));
  } catch (cause) {
    throw new ExperimentError("input_corrupt", "The label file is not valid", { cause });
  }
  const { manifest } = verified;
  if (labels.revision !== manifest.inputs.queries.revision) {
    throw new ExperimentError(
      "input_mismatch",
      `Labels are revision ${labels.revision}, the ranked queries are ${manifest.inputs.queries.revision}`,
    );
  }
  const labelIds = labels.cases.map((entry) => entry.id);
  if (
    new Set(labelIds).size !== labelIds.length ||
    labelIds.length !== verified.rankedIds.size ||
    labelIds.some((id) => !verified.rankedIds.has(id))
  ) {
    throw new ExperimentError("protocol_invalid", "Labels do not cover exactly the ranked queries");
  }

  const { resultLimit, reportedRanks } = manifest.scoring;
  const hitAt: Record<string, number> = Object.fromEntries(
    reportedRanks.map((rank) => [String(rank), 0]),
  );
  let reciprocalRankSum = 0;
  let scopeErrorCases = 0;
  let forbiddenBeforeCoreCases = 0;
  const cases: ControlCaseScore[] = [];
  for (const label of labels.cases) {
    const ids = verified.rankedIds.get(label.id)!;
    const coreRank = Math.max(...label.coreIds.map((id) => rankOf(ids, id, label.id)));
    const forbiddenRanks = label.forbiddenIds.map((id) => rankOf(ids, id, label.id));
    const scopeError = forbiddenRanks.some((rank) => rank <= resultLimit);
    const forbiddenBeforeCore = forbiddenRanks.some((rank) => rank < coreRank);
    for (const rank of reportedRanks) if (coreRank <= rank) hitAt[String(rank)]! += 1;
    reciprocalRankSum += 1 / coreRank;
    if (scopeError) scopeErrorCases += 1;
    if (forbiddenBeforeCore) forbiddenBeforeCoreCases += 1;
    cases.push({ queryId: label.id, coreRank, forbiddenRanks, scopeError, forbiddenBeforeCore });
  }
  const mrr = reciprocalRankSum / labels.cases.length;

  const differences: string[] = [];
  const compare = (name: string, actual: number, frozen: number, tolerance: number) => {
    if (Math.abs(actual - frozen) > tolerance) {
      differences.push(`${name}: observed ${actual}, frozen ${frozen}`);
    }
  };
  compare("hit@1", hitAt["1"] ?? Number.NaN, expected.hitAt1, 0);
  compare("hit@3", hitAt["3"] ?? Number.NaN, expected.hitAt3, 0);
  compare("hit@5", hitAt["5"] ?? Number.NaN, expected.hitAt5, 0);
  compare("hit@20", hitAt["20"] ?? Number.NaN, expected.hitAt20, 0);
  compare("MRR", mrr, expected.mrr, 0.00005);
  compare("scope", scopeErrorCases, expected.scopeErrorCases, 0);
  compare("forbidden-before-core", forbiddenBeforeCoreCases, expected.forbiddenBeforeCoreCases, 0);

  const report: ControlScoreReport = {
    scoreFormatVersion: 1,
    manifestDigest: verified.manifestDigest,
    rankingSha256: verified.rankingSha256,
    labelsSha256: sha256Hex(labelsBytes),
    labelsRevision: labels.revision,
    resultLimit,
    metrics: {
      caseCount: labels.cases.length,
      hitAt,
      mrr,
      scopeErrorCases,
      forbiddenBeforeCoreCases,
    },
    baseline: {
      expected,
      reproduced: differences.length === 0,
      differences,
    },
    cases,
  };
  await writeFile(join(directory, SCORE_FILE), JSON.stringify(report, null, 2), "utf8");
  return report;
}
