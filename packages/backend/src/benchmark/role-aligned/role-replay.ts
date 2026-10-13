import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { createEmbeddingProfile, indexCorpusDigest } from "@lorelum/engine";
import type { SemanticIndexVector } from "../../../../engine/src/query/semantic/index/database";
import type { SemanticQueryVector } from "../../../../engine/src/query/semantic/index/reader";
import type { SemanticArtifactQueryView } from "../../../../engine/src/query/semantic/read";
import { validateEmbeddingBatch } from "../../../../engine/src/query/semantic/encoding";
import {
  SEMANTIC_PROJECTION_VERSION,
  SEMANTIC_QUERY_PROJECTION_VERSION,
} from "../../../../engine/src/query/semantic/profile";
import { projectSemanticPractice } from "../../../../engine/src/query/semantic/projection";
import { projectSemanticQuery } from "../../../../engine/src/query/semantic/query-views";
import type { CodeIdentity } from "./manifest";
import { ENCODING_ID } from "../../modules/embedding/model";
import {
  compareScoredPractices,
  planRoleQuery,
  ROLE_POLICY_DIGEST,
  ROLE_POLICY_ID,
  type RoleQueryPlan,
} from "./candidate-policy";
import {
  assertOutsideRepository,
  ENCODE_TIMEOUT_MS,
  fileSha256,
  loadVectorCache,
  poolingOf,
  requireEqual,
  RUNTIME_START_TIMEOUT_MS,
  RUNTIME_STOP_TIMEOUT_MS,
  SCORE_TOLERANCE,
  writeArtifact,
  writeVectorCache,
  type ControlReplayDeps,
  type FrozenControlInputs,
} from "./control-replay";
import { recomputeControlScore, type FormulaView } from "./control-formula";
import { COST_BUDGET_DIGEST, COST_BUDGET_ID } from "./cost-budget";
import { digestJson, sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";
import { readCodeIdentity } from "./manifest";
import { appendBackground, BACKGROUND_SENTENCE, buildSegmentPlan } from "./negative-controls";
import {
  roleWeightsOf,
  scoreJointly,
  scoreSeparately,
  type RoleWeighting,
  type ScoringView,
  type TextVectors,
} from "./role-conditions";
import { parseRoleSample, type RoleSample } from "./role-sample";
import { scoreThreeChannel, type ThirdChannel } from "./summary-conditions";
import { summaryTexts } from "./summary-view";
import {
  PRACTICE_DIGESTS_FILE,
  ROLE_CONDITION_IDS,
  ROLE_RANKING_FORMAT_VERSION,
  ROLE_RUN_MANIFEST_FILE,
  ROLE_RUN_MANIFEST_VERSION,
  type CompleteRoleRunManifest,
  type FailedRoleRunManifest,
  type RoleConditionId,
} from "./role-run-manifest";

export const ROLE_EXPERIMENT_ID = "role-aligned-g1";

export interface RoleReplayConfig {
  readonly repoRoot: string;
  /** Local-only run directory; it must not lie inside the repository. */
  readonly outputDir: string;
  readonly queriesPath: string;
  readonly queries: {
    readonly revision: string;
    readonly caseCount: number;
    readonly sha256: string;
    readonly usage: "development" | "pilot";
  };
  readonly storeRoot: string;
  readonly modelPath: string;
  readonly nativeManifestPath: string;
  readonly threads: number;
  readonly codeFiles: readonly string[];
  /** Corpus, model and runtime identities; the query fields of these pins are not used. */
  readonly pins: Pick<
    FrozenControlInputs,
    | "practiceCount"
    | "viewCount"
    | "corpusDigest"
    | "modelSha256"
    | "modelBytes"
    | "nativeManifestSha256"
    | "threads"
    | "dimensions"
  >;
  /** One `<queryId>.json` role sample per query in each directory. */
  readonly roleSets: { readonly primary: string; readonly restated?: string };
  readonly provenance: {
    readonly independentOfTargets: boolean;
    readonly annotator: string;
    readonly disclosure: string;
  };
  readonly resultLimit: number;
  readonly reportedRanks: readonly number[];
}

const queriesSchema = z.object({
  revision: z.string().min(1),
  cases: z.array(z.object({ id: z.string().min(1), query: z.string().min(1) })).min(1),
});

export function rankingFileOf(id: RoleConditionId): string {
  return `ranking-${id.replaceAll("+", "plus")}.json`;
}

function percentile95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

async function loadRoleSet(
  directory: string,
  cases: readonly { id: string; query: string }[],
): Promise<{ samples: readonly RoleSample[]; digest: string; versions: readonly string[] }> {
  const samples: RoleSample[] = [];
  const identities: [string, string][] = [];
  for (const entry of cases) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(directory, `${entry.id}.json`), "utf8"));
    } catch (cause) {
      throw new ExperimentError(
        "input_missing",
        `Query ${entry.id} has no readable role sample; an unannotated query is not a fallback`,
        { cause },
      );
    }
    const validated = parseRoleSample(raw, { id: entry.id, text: entry.query });
    if (validated.sample.analysisKind !== "manual") {
      throw new ExperimentError(
        "protocol_invalid",
        `Role sample ${entry.id} is not manual; G1 tests manual roles only`,
      );
    }
    samples.push(validated.sample);
    identities.push([entry.id, validated.digest]);
  }
  return {
    samples,
    digest: digestJson(identities),
    versions: [...new Set(samples.map((sample) => sample.analysisVersion))].sort(),
  };
}

interface ConditionSpec {
  readonly id: Exclude<RoleConditionId, "control" | "N-background" | ThirdChannelId>;
  readonly plans: "primary" | "restated" | "segments";
  readonly joint: boolean;
  readonly weighting: RoleWeighting;
}

const THIRD_CHANNEL_CONDITIONS = [
  ["S", "summary"],
  ["S-dup", "duplicate"],
  ["F", "full"],
] as const satisfies readonly (readonly [RoleConditionId, ThirdChannel])[];
type ThirdChannelId = (typeof THIRD_CHANNEL_CONDITIONS)[number][0];

const ROLE_CONDITION_SPECS: readonly ConditionSpec[] = [
  { id: "Q", plans: "primary", joint: false, weighting: "registered" },
  { id: "Q+I", plans: "primary", joint: true, weighting: "registered" },
  { id: "Q-flat", plans: "primary", joint: false, weighting: "flat" },
  { id: "Q+I-flat", plans: "primary", joint: true, weighting: "flat" },
  { id: "N-segments", plans: "segments", joint: false, weighting: "registered" },
  { id: "Q-restated", plans: "restated", joint: false, weighting: "registered" },
  { id: "Q+I-restated", plans: "restated", joint: true, weighting: "registered" },
];

/**
 * Retrieval phase of every G1 condition. It reads queries, role samples, the
 * frozen corpus and the model, and writes one full ranking per condition plus
 * a manifest. It has no labels path; labels are read only by the scoring phase
 * after the rankings are verified.
 */
export async function runRoleReplay(
  config: RoleReplayConfig,
  deps: ControlReplayDeps,
): Promise<CompleteRoleRunManifest> {
  assertOutsideRepository(config.repoRoot, config.outputDir);
  await mkdir(config.outputDir, { recursive: true });
  await Promise.all(
    [
      ROLE_RUN_MANIFEST_FILE,
      PRACTICE_DIGESTS_FILE,
      ...ROLE_CONDITION_IDS.map((id) => rankingFileOf(id)),
    ].map((stale) => rm(join(config.outputDir, stale), { force: true })),
  );
  const code = await readCodeIdentity(config.repoRoot, config.codeFiles, deps.git);
  try {
    return await retrieve(config, deps, code);
  } catch (error) {
    const experimentError =
      error instanceof ExperimentError
        ? error
        : new ExperimentError("run_failed", "The role replay failed", { cause: error });
    const manifest: FailedRoleRunManifest = {
      manifestVersion: ROLE_RUN_MANIFEST_VERSION,
      status: "failed",
      experiment: { id: ROLE_EXPERIMENT_ID },
      code,
      failure: { code: experimentError.code, message: experimentError.message },
    };
    await writeFile(
      join(config.outputDir, ROLE_RUN_MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    throw experimentError;
  }
}

async function retrieve(
  config: RoleReplayConfig,
  deps: ControlReplayDeps,
  code: CodeIdentity,
): Promise<CompleteRoleRunManifest> {
  const { pins } = config;
  const started = deps.now();

  requireEqual("threads", config.threads, pins.threads);
  const queriesBytes = await readFile(config.queriesPath).catch((cause: unknown) => {
    throw new ExperimentError("input_missing", "The query file cannot be read", { cause });
  });
  requireEqual("query file digest", sha256Hex(queriesBytes), config.queries.sha256);
  const model = await fileSha256(config.modelPath);
  requireEqual("model digest", model.sha256, pins.modelSha256);
  requireEqual("model size", model.bytes, pins.modelBytes);
  const nativeManifest = await fileSha256(config.nativeManifestPath);
  requireEqual("native runtime manifest digest", nativeManifest.sha256, pins.nativeManifestSha256);
  let queries: z.infer<typeof queriesSchema>;
  try {
    queries = queriesSchema.parse(JSON.parse(Buffer.from(queriesBytes).toString("utf8")));
  } catch (cause) {
    throw new ExperimentError("input_corrupt", "The query file is not valid", { cause });
  }
  requireEqual("query revision", queries.revision, config.queries.revision);
  requireEqual("query count", queries.cases.length, config.queries.caseCount);
  if (new Set(queries.cases.map((entry) => entry.id)).size !== queries.cases.length) {
    throw new ExperimentError("input_corrupt", "The query file repeats a case ID");
  }

  const corpus = await deps.readCorpus(config.storeRoot);
  const practices = [...corpus.practices].sort((left, right) =>
    left.practiceId < right.practiceId ? -1 : left.practiceId > right.practiceId ? 1 : 0,
  );
  requireEqual("Practice count", practices.length, pins.practiceCount);
  const corpusDigest = indexCorpusDigest(practices);
  requireEqual("corpus digest", corpusDigest, pins.corpusDigest);
  const documents = practices.map((practice) => projectSemanticPractice(practice));
  const viewCount = documents.reduce((sum, document) => sum + document.views.length, 0);
  requireEqual("view count", viewCount, pins.viewCount);

  const primary = await loadRoleSet(config.roleSets.primary, queries.cases);
  const restated =
    config.roleSets.restated === undefined
      ? undefined
      : await loadRoleSet(config.roleSets.restated, queries.cases);

  // Per-query inputs of every condition.
  const clauses = queries.cases.map((entry) => projectSemanticQuery(entry.query));
  const backgroundClauses = queries.cases.map((entry) =>
    projectSemanticQuery(appendBackground(entry.query)),
  );
  const primaryPlans = primary.samples.map((sample) => planRoleQuery(sample));
  const restatedPlans = restated?.samples.map((sample) => planRoleQuery(sample));
  const segmentPlans = primary.samples.map((sample, index) =>
    buildSegmentPlan(sample, primaryPlans[index]!, queries.cases[index]!.query),
  );
  const plansOf = (kind: ConditionSpec["plans"]): readonly RoleQueryPlan[] | undefined =>
    kind === "primary" ? primaryPlans : kind === "restated" ? restatedPlans : segmentPlans;
  const planTexts = (plan: RoleQueryPlan): string[] =>
    plan.status === "roles" ? [...new Set(plan.roles.flatMap((planned) => planned.texts))] : [];

  const texts = new Map<string, string>();
  const add = (text: string) => texts.set(sha256Hex(text), text);
  for (const document of documents) for (const view of document.views) add(view.text);
  const summaryTextsOf = practices.map((practice) => summaryTexts(practice.practice));
  for (const group of summaryTextsOf) for (const text of group) add(text);
  for (const group of [clauses, backgroundClauses]) {
    for (const items of group) for (const clause of items) add(clause.text);
  }
  for (const plans of [primaryPlans, restatedPlans, segmentPlans]) {
    for (const plan of plans ?? []) for (const text of planTexts(plan)) add(text);
  }

  // Vector cache, reusable only under an identical encoding and code identity.
  const encodingId = ENCODING_ID;
  const profile = createEmbeddingProfile({ encodingId, dimensions: pins.dimensions });
  const pooling = poolingOf(config.modelPath, config.threads);
  const vectorIdentity = digestJson({
    cacheVersion: 1,
    modelSha256: model.sha256,
    encodingId,
    pooling,
    dimensions: pins.dimensions,
    threads: config.threads,
    nativeManifestSha256: nativeManifest.sha256,
    codeDigest: code.digest,
  });
  const cache = await loadVectorCache(config.outputDir, vectorIdentity, pins.dimensions);
  const vectors = cache.vectors;
  const missing = [...texts].filter(([key]) => !vectors.has(key));
  const encodeMs = new Map<string, number>();
  let encodeCalls = 0;
  if (missing.length > 0) {
    const runtime = deps.createRuntime();
    try {
      await runtime.start(
        AbortSignal.timeout(RUNTIME_START_TIMEOUT_MS),
        Date.now() + RUNTIME_START_TIMEOUT_MS,
      );
      for (const [key, text] of missing) {
        encodeCalls += 1;
        const mark = deps.now();
        // eslint-disable-next-line no-await-in-loop -- Encoding is sequential like production.
        const raw = await runtime.encode(text, AbortSignal.timeout(ENCODE_TIMEOUT_MS));
        encodeMs.set(key, deps.now() - mark);
        const [vector] = validateEmbeddingBatch(
          { encodingId, dimensions: pins.dimensions },
          [text],
          { encodingId, vectors: [raw] },
        );
        vectors.set(key, vector!);
      }
    } finally {
      await runtime.stop(Date.now() + RUNTIME_STOP_TIMEOUT_MS);
    }
    await writeVectorCache(config.outputDir, vectorIdentity, vectors);
  }
  const vectorOf = (text: string): Float32Array => {
    const vector = vectors.get(sha256Hex(text));
    if (vector === undefined) {
      throw new ExperimentError("run_failed", "A projected text has no vector");
    }
    return vector;
  };
  const textVectors: TextVectors = new Map(
    [...texts.values()].map((text) => [text, vectorOf(text)]),
  );

  const productionViews = documents.map((document) =>
    document.views.map(
      (view): SemanticIndexVector => ({
        viewId: view.viewId,
        viewKind: view.viewKind,
        viewOrdinal: view.ordinal,
        contentDigest: view.contentDigest,
        projectionDigest: view.projectionDigest,
        vector: vectorOf(view.text),
      }),
    ),
  );
  const formulaViews = productionViews.map((views) =>
    views.map(
      (view): FormulaView => ({ viewId: view.viewId, kind: view.viewKind, vector: view.vector }),
    ),
  );
  const scoringViews: ScoringView[][] = formulaViews.map((views) =>
    views.map((view) => ({ kind: view.kind, vector: view.vector })),
  );

  // Scoring. `scoreQuery` returns one score per Practice, in corpus order.
  const clauseVectors = (items: readonly SemanticArtifactQueryView[]) =>
    items.map((clause) => ({
      viewId: clause.viewId,
      vector: vectorOf(clause.text),
      weight: clause.weight,
    }));
  const controlScores = (items: readonly SemanticArtifactQueryView[]): number[] => {
    const weighted = clauseVectors(items);
    return formulaViews.map((views) => recomputeControlScore(weighted, views));
  };
  const summaryVectors = summaryTextsOf.map((group) => group.map((text) => vectorOf(text)));

  const scoringMs = new Map<RoleConditionId, number[]>();
  const fallbackCounts = new Map<RoleConditionId, number>();
  const maxTexts = new Map<RoleConditionId, number>();
  const scores = new Map<RoleConditionId, number[][]>();
  const record = (id: RoleConditionId, query: number, textCount: number, run: () => number[]) => {
    const mark = deps.now();
    const result = run();
    const list = scoringMs.get(id) ?? [];
    list[query] = deps.now() - mark;
    scoringMs.set(id, list);
    maxTexts.set(id, Math.max(maxTexts.get(id) ?? 0, textCount));
    const rows = scores.get(id) ?? [];
    rows[query] = result;
    scores.set(id, rows);
  };

  // Production pass of the control condition, kept only to verify the independent formula.
  let pairCount = 0;
  let maxAbsDelta = 0;
  let mismatchCount = 0;
  queries.cases.forEach((_, query) => {
    const weighted = clauseVectors(clauses[query]!);
    const independent: number[] = [];
    record("control", query, clauses[query]!.length, () => {
      independent.push(...controlScores(clauses[query]!));
      return independent;
    });
    productionViews.forEach((views, practice) => {
      const production = deps.scorePractice(
        weighted as SemanticQueryVector[],
        views,
        pins.dimensions,
      ).score;
      const delta = Math.abs(production - independent[practice]!);
      pairCount += 1;
      maxAbsDelta = Math.max(maxAbsDelta, delta);
      if (!(delta <= SCORE_TOLERANCE)) mismatchCount += 1;
    });
    record("N-background", query, backgroundClauses[query]!.length, () =>
      controlScores(backgroundClauses[query]!),
    );
    for (const [id, third] of THIRD_CHANNEL_CONDITIONS) {
      record(id, query, clauses[query]!.length, () =>
        scoringViews.map((views, practice) =>
          scoreThreeChannel(weighted, views, third, summaryVectors[practice]!),
        ),
      );
    }
    for (const spec of ROLE_CONDITION_SPECS) {
      const plan = plansOf(spec.plans)?.[query];
      if (plan === undefined) continue;
      if (plan.status !== "roles") {
        fallbackCounts.set(spec.id, (fallbackCounts.get(spec.id) ?? 0) + 1);
        record(spec.id, query, clauses[query]!.length, () => controlScores(clauses[query]!));
        continue;
      }
      const weights = roleWeightsOf(plan, spec.weighting);
      const score = spec.joint ? scoreJointly : scoreSeparately;
      record(spec.id, query, planTexts(plan).length, () =>
        scoringViews.map((views) => score(plan, weights, textVectors, views)),
      );
    }
  });
  if (mismatchCount > 0) {
    throw new ExperimentError(
      "score_mismatch",
      `${mismatchCount} of ${pairCount} control pairs exceed ${SCORE_TOLERANCE} (max ${maxAbsDelta})`,
    );
  }

  // Full rankings; K is applied only when a ranking is read.
  const conditions: CompleteRoleRunManifest["conditions"] = [];
  for (const id of ROLE_CONDITION_IDS) {
    const rows = scores.get(id);
    if (rows === undefined) continue;
    const ranking = await writeArtifact(config.outputDir, rankingFileOf(id), {
      rankingFormatVersion: ROLE_RANKING_FORMAT_VERSION,
      condition: id,
      cases: queries.cases.map((entry, query) => ({
        queryId: entry.id,
        queryDigest: sha256Hex(entry.query),
        ranked: practices
          .map((practice, index) => ({
            practiceId: practice.practiceId,
            score: rows[query]![index]!,
          }))
          .sort(compareScoredPractices)
          .map((item, index) => ({ ...item, rank: index + 1 })),
      })),
    });
    const times = scoringMs.get(id) ?? [];
    conditions.push({
      id,
      ranking,
      queryCount: queries.cases.length,
      fallbackQueries: fallbackCounts.get(id) ?? 0,
      maxTextsPerQuery: maxTexts.get(id) ?? 0,
      scoringMsMean: times.reduce((sum, value) => sum + value, 0) / times.length,
      scoringMsP95: percentile95(times),
    });
  }
  const practiceDigests = await writeArtifact(
    config.outputDir,
    PRACTICE_DIGESTS_FILE,
    Object.fromEntries(practices.map((practice) => [practice.practiceId, practice.contentDigest])),
  );

  const encodedQueryMs: number[] = [];
  for (const plan of primaryPlans) {
    const own = planTexts(plan).map((text) => encodeMs.get(sha256Hex(text)));
    const known = own.filter((value): value is number => value !== undefined);
    if (known.length > 0 && known.length === own.length) {
      encodedQueryMs.push(known.reduce((sum, value) => sum + value, 0));
    }
  }
  const manifest: CompleteRoleRunManifest = {
    manifestVersion: ROLE_RUN_MANIFEST_VERSION,
    status: "complete",
    experiment: {
      id: ROLE_EXPERIMENT_ID,
      policyId: ROLE_POLICY_ID,
      policyDigest: ROLE_POLICY_DIGEST,
      costBudgetId: COST_BUDGET_ID,
      costBudgetDigest: COST_BUDGET_DIGEST,
      usage: config.queries.usage,
      backgroundSentences: { ...BACKGROUND_SENTENCE },
    },
    code,
    inputs: {
      queries: {
        revision: queries.revision,
        caseCount: queries.cases.length,
        sha256: config.queries.sha256,
      },
      corpus: {
        digest: corpusDigest,
        snapshotIdentity: { ...corpus.identity },
        practiceCount: practices.length,
        viewCount,
      },
      model: { sha256: model.sha256, bytes: model.bytes },
      nativeManifestSha256: nativeManifest.sha256,
      roleSets: [
        {
          set: "primary",
          sampleCount: primary.samples.length,
          analysisVersions: [...primary.versions],
          digest: primary.digest,
        },
        ...(restated === undefined
          ? []
          : [
              {
                set: "restated" as const,
                sampleCount: restated.samples.length,
                analysisVersions: [...restated.versions],
                digest: restated.digest,
              },
            ]),
      ],
      roleProvenance: { ...config.provenance },
    },
    encoding: {
      encodingId,
      profileId: profile.profileId,
      pooling,
      normalization: "l2",
      threads: config.threads,
      dimensions: pins.dimensions,
    },
    projection: {
      documentVersion: SEMANTIC_PROJECTION_VERSION,
      queryVersion: SEMANTIC_QUERY_PROJECTION_VERSION,
      vectorIdentity,
    },
    scoring: {
      resultLimit: config.resultLimit,
      reportedRanks: [...config.reportedRanks],
      rankingDepth: practices.length,
    },
    controlComparison: { pairCount, maxAbsDelta, toleranceAbs: SCORE_TOLERANCE, mismatchCount },
    conditions,
    artifacts: { practiceDigests },
    cost: {
      cacheState: cache.state,
      distinctTexts: texts.size,
      cachedTexts: texts.size - missing.length,
      encodeCalls,
      encodeMsTotal: [...encodeMs.values()].reduce((sum, value) => sum + value, 0),
      encodeMsPerQueryP95: encodedQueryMs.length > 0 ? percentile95(encodedQueryMs) : null,
      totalMs: deps.now() - started,
      peakRssBytes: Math.round(deps.peakRssBytes()),
    },
    environment: deps.environment(),
  };
  await writeFile(
    join(config.outputDir, ROLE_RUN_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  return manifest;
}
