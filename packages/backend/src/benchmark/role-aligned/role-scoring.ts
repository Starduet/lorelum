import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { compareScoredPractices } from "./candidate-policy";
import { COST_BUDGET } from "./cost-budget";
import { sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";
import { verifyArtifact } from "./manifest";
import { parsePilotLabel, summarizeTopK, type PilotLabel, type TopKSummary } from "./pilot-labels";
import {
  PRACTICE_DIGESTS_FILE,
  readRoleRunManifest,
  ROLE_RANKING_FORMAT_VERSION,
  type CompleteRoleRunManifest,
  type RoleConditionId,
} from "./role-run-manifest";

export const ROLE_SCORE_FILE = "role-score.json";

/** The pre-registered G1 thresholds; all of them were fixed before any role result existed. */
export const G1_THRESHOLDS = Object.freeze({
  /** Research plan 6.3 item 3, applied to the reused v2 development set. */
  developmentHitAt5Minimum: 45,
  developmentScopeMaximum: 2,
  developmentForbiddenBeforeCoreMaximum: 1,
  /** Fewest pilot queries a verdict may rest on; a workload floor, not a power claim. */
  pilotMinimumQueries: 24,
  /** Label coverage is comparable when the unlabelled top-K slots differ by at most this share of all slots. */
  coverageComparableShare: 0.1,
});

const rankingSchema = z.strictObject({
  rankingFormatVersion: z.literal(ROLE_RANKING_FORMAT_VERSION),
  condition: z.string().min(1),
  cases: z.array(
    z.strictObject({
      queryId: z.string().min(1),
      queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
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

export interface VerifiedRoleRun {
  readonly manifest: CompleteRoleRunManifest;
  /** Condition, then query: Practice IDs in rank order. */
  readonly rankedIds: ReadonlyMap<RoleConditionId, ReadonlyMap<string, readonly string[]>>;
  readonly practiceDigests: ReadonlyMap<string, string>;
}

/**
 * Stage gate between retrieval and labels. Every ranking must still match the
 * manifest digest and be a full, ordered, duplicate-free list of the corpus.
 */
export async function readVerifiedRoleRun(directory: string): Promise<VerifiedRoleRun> {
  const manifest = await readRoleRunManifest(directory);
  if (manifest.status !== "complete") {
    throw new ExperimentError(
      "stage_violation",
      `The run ended as ${manifest.status} (${manifest.failure.code}); its rankings must not be scored`,
    );
  }
  const rankedIds = new Map<RoleConditionId, ReadonlyMap<string, readonly string[]>>();
  for (const condition of manifest.conditions) {
    const bytes = await verifyArtifact(directory, condition.ranking);
    let ranking: z.infer<typeof rankingSchema>;
    try {
      ranking = rankingSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    } catch (cause) {
      throw new ExperimentError("input_corrupt", `Ranking of ${condition.id} is not valid`, {
        cause,
      });
    }
    if (
      ranking.condition !== condition.id ||
      ranking.cases.length !== manifest.inputs.queries.caseCount
    ) {
      throw new ExperimentError(
        "input_corrupt",
        `Ranking of ${condition.id} does not match its manifest`,
      );
    }
    const byQuery = new Map<string, readonly string[]>();
    for (const entry of ranking.cases) {
      const ids = entry.ranked.map((item) => item.practiceId);
      const ordered = entry.ranked.every(
        (item, index) =>
          item.rank === index + 1 &&
          (index === 0 ||
            compareScoredPractices(
              {
                practiceId: entry.ranked[index - 1]!.practiceId,
                score: entry.ranked[index - 1]!.score,
              },
              { practiceId: item.practiceId, score: item.score },
            ) <= 0),
      );
      if (
        byQuery.has(entry.queryId) ||
        ids.length !== manifest.scoring.rankingDepth ||
        new Set(ids).size !== ids.length ||
        !ordered
      ) {
        throw new ExperimentError(
          "input_corrupt",
          `Ranking of ${condition.id} for ${entry.queryId} is not a full ordered list of the corpus`,
        );
      }
      byQuery.set(entry.queryId, ids);
    }
    rankedIds.set(condition.id, byQuery);
  }
  if (!rankedIds.has("control")) {
    throw new ExperimentError("input_corrupt", "The run has no control ranking");
  }
  let digests: Record<string, string>;
  try {
    const bytes = await verifyArtifact(directory, manifest.artifacts.practiceDigests);
    digests = z
      .record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
      .parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  } catch (cause) {
    if (cause instanceof ExperimentError) throw cause;
    throw new ExperimentError("input_corrupt", `${PRACTICE_DIGESTS_FILE} is not valid`, { cause });
  }
  return { manifest, rankedIds, practiceDigests: new Map(Object.entries(digests)) };
}

// ---------------------------------------------------------------- development (v2 labels)

const developmentLabelsSchema = z.object({
  revision: z.string().min(1),
  cases: z.array(
    z.object({
      id: z.string().min(1),
      coreIds: z.array(z.string().min(1)).min(1),
      forbiddenIds: z.array(z.string().min(1)),
    }),
  ),
});

export interface DevelopmentCase {
  readonly queryId: string;
  /** Rank at which every core Practice is present. */
  readonly coreRank: number;
  readonly scopeError: boolean;
  readonly forbiddenBeforeCore: boolean;
}

export interface DevelopmentMetrics {
  readonly hitAt: Readonly<Record<string, number>>;
  readonly mrr: number;
  readonly scopeErrorCases: number;
  readonly forbiddenBeforeCoreCases: number;
  readonly cases: readonly DevelopmentCase[];
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

export function scoreDevelopmentRanking(
  labels: z.infer<typeof developmentLabelsSchema>,
  rankedIds: ReadonlyMap<string, readonly string[]>,
  resultLimit: number,
  reportedRanks: readonly number[],
): DevelopmentMetrics {
  const hitAt: Record<string, number> = Object.fromEntries(
    reportedRanks.map((rank) => [String(rank), 0]),
  );
  const cases: DevelopmentCase[] = [];
  let reciprocalRankSum = 0;
  for (const label of labels.cases) {
    const ids = rankedIds.get(label.id)!;
    const coreRank = Math.max(...label.coreIds.map((id) => rankOf(ids, id, label.id)));
    const forbiddenRanks = label.forbiddenIds.map((id) => rankOf(ids, id, label.id));
    for (const rank of reportedRanks) if (coreRank <= rank) hitAt[String(rank)]! += 1;
    reciprocalRankSum += 1 / coreRank;
    cases.push({
      queryId: label.id,
      coreRank,
      scopeError: forbiddenRanks.some((rank) => rank <= resultLimit),
      forbiddenBeforeCore: forbiddenRanks.some((rank) => rank < coreRank),
    });
  }
  return {
    hitAt,
    mrr: reciprocalRankSum / labels.cases.length,
    scopeErrorCases: cases.filter((entry) => entry.scopeError).length,
    forbiddenBeforeCoreCases: cases.filter((entry) => entry.forbiddenBeforeCore).length,
    cases,
  };
}

export interface PairedChange {
  readonly improved: readonly string[];
  readonly regressed: readonly string[];
  readonly unchanged: number;
}

function pairedCoreRank(control: DevelopmentMetrics, other: DevelopmentMetrics): PairedChange {
  const improved: string[] = [];
  const regressed: string[] = [];
  other.cases.forEach((entry, index) => {
    const before = control.cases[index]!.coreRank;
    if (entry.coreRank < before) improved.push(entry.queryId);
    else if (entry.coreRank > before) regressed.push(entry.queryId);
  });
  return {
    improved,
    regressed,
    unchanged: other.cases.length - improved.length - regressed.length,
  };
}

// ---------------------------------------------------------------- pilot (protocol v2 labels)

export interface PilotCase {
  readonly queryId: string;
  readonly noRelevantTarget: boolean;
  readonly summary: TopKSummary;
}

export interface PilotMetrics {
  readonly queryCount: number;
  /** Queries with a relevant target: the denominator of the success counts. */
  readonly targetedQueries: number;
  readonly success: number;
  readonly fullyServed: number;
  readonly anyHelp: number;
  readonly forbiddenQueries: number;
  /** Top-K slots without a label, summed over all queries; undetermined slots are counted apart. */
  readonly unlabelledSlots: number;
  readonly undeterminedSlots: number;
  readonly noTargetQueriesWithForbidden: number;
  readonly cases: readonly PilotCase[];
}

export function scorePilotRanking(
  labels: ReadonlyMap<string, PilotLabel>,
  rankedIds: ReadonlyMap<string, readonly string[]>,
  resultLimit: number,
): PilotMetrics {
  const cases: PilotCase[] = [];
  for (const [queryId, label] of labels) {
    cases.push({
      queryId,
      noRelevantTarget: label.noRelevantTarget,
      summary: summarizeTopK(label, rankedIds.get(queryId)!, resultLimit),
    });
  }
  const targeted = cases.filter((entry) => !entry.noRelevantTarget);
  return {
    queryCount: cases.length,
    targetedQueries: targeted.length,
    success: targeted.filter((entry) => entry.summary.success).length,
    fullyServed: targeted.filter((entry) => entry.summary.fullyServed).length,
    anyHelp: targeted.filter((entry) => entry.summary.anyHelp).length,
    forbiddenQueries: cases.filter((entry) => entry.summary.hasForbidden).length,
    unlabelledSlots: cases.reduce((sum, entry) => sum + entry.summary.classCounts.unlabelled, 0),
    undeterminedSlots: cases.reduce(
      (sum, entry) => sum + entry.summary.classCounts.undetermined,
      0,
    ),
    noTargetQueriesWithForbidden: cases.filter(
      (entry) => entry.noRelevantTarget && entry.summary.hasForbidden,
    ).length,
    cases,
  };
}

function pairedSuccess(control: PilotMetrics, other: PilotMetrics): PairedChange {
  const improved: string[] = [];
  const regressed: string[] = [];
  other.cases.forEach((entry, index) => {
    const before = control.cases[index]!;
    if (entry.noRelevantTarget) return;
    if (entry.summary.success && !before.summary.success) improved.push(entry.queryId);
    else if (!entry.summary.success && before.summary.success) regressed.push(entry.queryId);
  });
  return {
    improved,
    regressed,
    unchanged: other.cases.length - improved.length - regressed.length,
  };
}

// ---------------------------------------------------------------- gates

export type CriterionStatus = "pass" | "fail" | "uncertain";

export interface Criterion {
  readonly id: string;
  readonly status: CriterionStatus;
  readonly detail: string;
}

export interface GateReport {
  readonly candidate: RoleConditionId;
  readonly criteria: readonly Criterion[];
  /** Any failed criterion fails; otherwise any uncertain criterion makes the verdict uncertain. */
  readonly verdict: CriterionStatus;
}

export interface CostCheck {
  readonly item: string;
  readonly limit: number;
  readonly observed: number | null;
  readonly within: boolean | null;
}

/**
 * Research plan section 6.3 applied to one candidate. The plan item numbers
 * are kept in the criterion ids. Cost is reported next to the verdict and
 * never traded against quality.
 */
export function evaluateGates(input: {
  readonly candidate: RoleConditionId;
  readonly manifest: CompleteRoleRunManifest;
  readonly development?: { control: DevelopmentMetrics; candidate: DevelopmentMetrics };
  readonly pilot?: { control: PilotMetrics; candidate: PilotMetrics; labelsIndependent: boolean };
}): GateReport {
  const { candidate, manifest, development, pilot } = input;
  const criteria: Criterion[] = [];
  criteria.push({
    id: "1-control-reproduced",
    status: manifest.controlComparison.mismatchCount === 0 ? "pass" : "fail",
    detail: `${manifest.controlComparison.pairCount} pairs, max |delta| ${manifest.controlComparison.maxAbsDelta}`,
  });

  if (development === undefined) {
    criteria.push({
      id: "3-development-regression",
      status: "uncertain",
      detail: "no development run was scored",
    });
  } else {
    const control = development.control;
    const observed = development.candidate;
    const failures: string[] = [];
    if ((observed.hitAt["5"] ?? 0) < G1_THRESHOLDS.developmentHitAt5Minimum)
      failures.push(`hit@5 ${observed.hitAt["5"]}`);
    if (observed.mrr < control.mrr)
      failures.push(`MRR ${observed.mrr.toFixed(6)} < control ${control.mrr.toFixed(6)}`);
    if (observed.scopeErrorCases > G1_THRESHOLDS.developmentScopeMaximum)
      failures.push(`scope ${observed.scopeErrorCases}`);
    if (observed.forbiddenBeforeCoreCases > G1_THRESHOLDS.developmentForbiddenBeforeCoreMaximum) {
      failures.push(`forbidden-before-core ${observed.forbiddenBeforeCoreCases}`);
    }
    criteria.push({
      id: "3-development-regression",
      status: failures.length === 0 ? "pass" : "fail",
      detail:
        failures.length === 0
          ? `hit@5 ${observed.hitAt["5"]}, MRR ${observed.mrr.toFixed(6)}, scope ${observed.scopeErrorCases}, forbidden-before-core ${observed.forbiddenBeforeCoreCases}`
          : failures.join("; "),
    });
  }

  if (pilot === undefined) {
    criteria.push({
      id: "2-pilot-improvement",
      status: "uncertain",
      detail:
        "no pilot run was scored; the reused development set is not an independent acceptance set",
    });
  } else {
    const { control, candidate: observed } = pilot;
    const slots = control.queryCount * manifest.scoring.resultLimit;
    const coverageGap = Math.abs(observed.unlabelledSlots - control.unlabelledSlots);
    const coverageComparable = coverageGap <= G1_THRESHOLDS.coverageComparableShare * slots;
    // These keep an otherwise strict improvement from counting as a pass.
    const blockers: string[] = [];
    if (manifest.experiment.usage !== "pilot") blockers.push("the run is not marked as a pilot");
    if (!manifest.inputs.roleProvenance.independentOfTargets)
      blockers.push("role annotation is not independent of targets");
    if (!pilot.labelsIndependent) blockers.push("relevance labels are not independent");
    if (control.queryCount < G1_THRESHOLDS.pilotMinimumQueries) {
      blockers.push(
        `${control.queryCount} queries is below the registered minimum ${G1_THRESHOLDS.pilotMinimumQueries}`,
      );
    }
    const detail = `success ${observed.success} vs control ${control.success} of ${control.targetedQueries} targeted queries; forbidden queries ${observed.forbiddenQueries} vs ${control.forbiddenQueries}; unlabelled top-K slots ${observed.unlabelledSlots} vs ${control.unlabelledSlots} of ${slots}`;
    const push = (status: CriterionStatus, note: string) =>
      criteria.push({ id: "2-pilot-improvement", status, detail: `${detail}; ${note}` });
    if (!coverageComparable) push("uncertain", "label coverage is not comparable");
    else if (observed.forbiddenQueries > control.forbiddenQueries)
      push("fail", "forbidden queries increased");
    else if (observed.success <= control.success) push("fail", "no strict improvement");
    else if (blockers.length > 0) push("uncertain", blockers.join("; "));
    else push("pass", "strict improvement");
  }
  const verdict: CriterionStatus = criteria.some((entry) => entry.status === "fail")
    ? "fail"
    : criteria.some((entry) => entry.status === "uncertain")
      ? "uncertain"
      : "pass";
  return { candidate, criteria, verdict };
}

/** Cost items of the registered budget that this run can observe. */
export function checkCost(manifest: CompleteRoleRunManifest): Record<string, readonly CostCheck[]> {
  const result: Record<string, readonly CostCheck[]> = {};
  for (const condition of manifest.conditions) {
    const checks: CostCheck[] = [
      {
        item: "encoded texts per query",
        limit: COST_BUDGET.query.maxEncodedTextsPerQuery,
        observed: condition.maxTextsPerQuery,
        within: condition.maxTextsPerQuery <= COST_BUDGET.query.maxEncodedTextsPerQuery,
      },
      {
        item: "scoring ms per query (mean)",
        limit: COST_BUDGET.query.scoringMsMean,
        observed: condition.scoringMsMean,
        within: condition.scoringMsMean <= COST_BUDGET.query.scoringMsMean,
      },
    ];
    result[condition.id] = checks;
  }
  const encode = manifest.cost.encodeMsPerQueryP95;
  result["run"] = [
    {
      item: "encode ms per query (p95, primary role texts)",
      limit: COST_BUDGET.query.encodeMsP95,
      observed: encode,
      within: encode === null ? null : encode <= COST_BUDGET.query.encodeMsP95,
    },
    {
      item: "evaluation process peak RSS (MB)",
      limit: COST_BUDGET.memory.evaluationProcessPeakRssMegabytes,
      observed: manifest.cost.peakRssBytes / 1_000_000,
      within:
        manifest.cost.peakRssBytes / 1_000_000 <=
        COST_BUDGET.memory.evaluationProcessPeakRssMegabytes,
    },
  ];
  return result;
}

// ---------------------------------------------------------------- orchestration

export interface RoleScoringDeps {
  /** The only places labels are read; both run after the rankings are verified. */
  readDevelopmentLabels?(): Promise<Uint8Array>;
  readPilotLabel?(queryId: string): Promise<unknown>;
  /** The exact query file the run used; it is checked against the manifest digest. */
  readQueries(): Promise<Uint8Array>;
  pilotLabelsIndependent: boolean;
}

export interface ConditionReport {
  readonly id: RoleConditionId;
  readonly development?: DevelopmentMetrics & { readonly versusControl: PairedChange };
  readonly pilot?: PilotMetrics & { readonly versusControl: PairedChange };
}

export interface RoleScoreReport {
  readonly scoreFormatVersion: 1;
  readonly manifestSha256: string;
  readonly usage: "development" | "pilot";
  readonly labelsSha256?: string;
  readonly conditions: readonly ConditionReport[];
  readonly gates: readonly GateReport[];
  readonly cost: Record<string, readonly CostCheck[]>;
}

const CANDIDATES: readonly RoleConditionId[] = ["Q", "Q+I", "S"];

export async function scoreRoleRun(
  directory: string,
  deps: RoleScoringDeps,
): Promise<RoleScoreReport> {
  const run = await readVerifiedRoleRun(directory);
  const { manifest } = run;
  const manifestBytes = await readFile(join(directory, "role-manifest.json"));
  const queriesBytes = await deps.readQueries();
  if (sha256Hex(queriesBytes) !== manifest.inputs.queries.sha256) {
    throw new ExperimentError("input_mismatch", "The query file is not the one the run used");
  }
  const queries = z
    .object({ cases: z.array(z.object({ id: z.string(), query: z.string() })) })
    .parse(JSON.parse(Buffer.from(queriesBytes).toString("utf8"))).cases;
  const { resultLimit, reportedRanks } = manifest.scoring;
  const ids = manifest.conditions.map((condition) => condition.id);

  let development: Map<RoleConditionId, DevelopmentMetrics> | undefined;
  let labelsSha256: string | undefined;
  if (deps.readDevelopmentLabels !== undefined) {
    const bytes = await deps.readDevelopmentLabels();
    labelsSha256 = sha256Hex(bytes);
    let labels: z.infer<typeof developmentLabelsSchema>;
    try {
      labels = developmentLabelsSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
    } catch (cause) {
      throw new ExperimentError("input_corrupt", "The development label file is not valid", {
        cause,
      });
    }
    const labelIds = labels.cases.map((entry) => entry.id);
    if (
      labels.revision !== manifest.inputs.queries.revision ||
      new Set(labelIds).size !== labelIds.length ||
      labelIds.length !== queries.length ||
      queries.some((entry) => !labelIds.includes(entry.id))
    ) {
      throw new ExperimentError(
        "protocol_invalid",
        "Labels do not cover exactly the ranked queries",
      );
    }
    development = new Map(
      ids.map((id) => [
        id,
        scoreDevelopmentRanking(labels, run.rankedIds.get(id)!, resultLimit, reportedRanks),
      ]),
    );
  }

  let pilot: Map<RoleConditionId, PilotMetrics> | undefined;
  if (deps.readPilotLabel !== undefined) {
    const labels = new Map<string, PilotLabel>();
    for (const entry of queries) {
      labels.set(
        entry.id,
        parsePilotLabel(
          await deps.readPilotLabel(entry.id),
          { id: entry.id, text: entry.query },
          run.practiceDigests,
        ),
      );
    }
    pilot = new Map(
      ids.map((id) => [id, scorePilotRanking(labels, run.rankedIds.get(id)!, resultLimit)]),
    );
  }

  const conditions: ConditionReport[] = ids.map((id) => {
    const developmentMetrics = development?.get(id);
    const pilotMetrics = pilot?.get(id);
    return {
      id,
      ...(developmentMetrics === undefined
        ? {}
        : {
            development: {
              ...developmentMetrics,
              versusControl: pairedCoreRank(development!.get("control")!, developmentMetrics),
            },
          }),
      ...(pilotMetrics === undefined
        ? {}
        : {
            pilot: {
              ...pilotMetrics,
              versusControl: pairedSuccess(pilot!.get("control")!, pilotMetrics),
            },
          }),
    };
  });
  const gates = CANDIDATES.filter((id) => ids.includes(id)).map((candidate) =>
    evaluateGates({
      candidate,
      manifest,
      ...(development === undefined
        ? {}
        : {
            development: {
              control: development.get("control")!,
              candidate: development.get(candidate)!,
            },
          }),
      ...(pilot === undefined
        ? {}
        : {
            pilot: {
              control: pilot.get("control")!,
              candidate: pilot.get(candidate)!,
              labelsIndependent: deps.pilotLabelsIndependent,
            },
          }),
    }),
  );
  const report: RoleScoreReport = {
    scoreFormatVersion: 1,
    manifestSha256: sha256Hex(manifestBytes),
    usage: manifest.experiment.usage,
    ...(labelsSha256 === undefined ? {} : { labelsSha256 }),
    conditions,
    gates,
    cost: checkCost(manifest),
  };
  await writeFile(join(directory, ROLE_SCORE_FILE), JSON.stringify(report, null, 2), "utf8");
  return report;
}
