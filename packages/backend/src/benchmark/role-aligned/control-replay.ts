import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";

import { createEmbeddingProfile, indexCorpusDigest, type EffectivePractice } from "@lorelum/engine";
import type { SemanticIndexVector } from "../../../../engine/src/query/semantic/index/database";
import {
  scoreSemanticPractice,
  type SemanticQueryVector,
} from "../../../../engine/src/query/semantic/index/reader";
import {
  SEMANTIC_PROJECTION_VERSION,
  SEMANTIC_QUERY_PROJECTION_VERSION,
} from "../../../../engine/src/query/semantic/profile";
import { validateEmbeddingBatch } from "../../../../engine/src/query/semantic/encoding";
import { projectSemanticPractice } from "../../../../engine/src/query/semantic/projection";
import { projectSemanticQuery } from "../../../../engine/src/query/semantic/query-views";
import { EMBEDDING_MODEL, ENCODING_ID, type EmbeddingRuntime } from "../../modules/embedding/model";
import { llamaArguments } from "../../runtime/llama-options";
import { compareScoredPractices, ROLE_POLICY_DIGEST, ROLE_POLICY_ID } from "./candidate-policy";
import { recomputeControlScore, type FormulaView } from "./control-formula";
import { COST_BUDGET_DIGEST, COST_BUDGET_ID } from "./cost-budget";
import { digestJson, sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";
import {
  COMPARISON_FILE,
  RANKING_FILE,
  RANKING_FORMAT_VERSION,
  readCodeIdentity,
  RUN_MANIFEST_FILE,
  RUN_MANIFEST_VERSION,
  type CodeIdentity,
  type CompleteRunManifest,
  type FailedRunManifest,
  type GitProbe,
  type RunCost,
  type RunEnvironment,
} from "./manifest";

export const CONTROL_EXPERIMENT_ID = "role-aligned-g0-control";
export const CONTROL_FORMULA_ID = "production scoreSemanticPractice / scoring-formula-pin";
export const VECTOR_CACHE_FILE = "vector-cache.json";
export const SCORE_TOLERANCE = 1e-6;

/** Identities the frozen development set must have; a difference is an input mismatch, never a miss. */
export interface FrozenControlInputs {
  readonly suiteRevision: string;
  readonly caseCount: number;
  readonly queriesSha256: string;
  readonly practiceCount: number;
  readonly viewCount: number;
  readonly corpusDigest: string;
  readonly modelSha256: string;
  readonly modelBytes: number;
  readonly nativeManifestSha256: string;
  readonly threads: number;
  readonly dimensions: number;
}

export interface ControlReplayConfig {
  readonly repoRoot: string;
  /** Local-only run directory; it must not lie inside the repository. */
  readonly outputDir: string;
  readonly queriesPath: string;
  readonly storeRoot: string;
  readonly modelPath: string;
  readonly nativeManifestPath: string;
  readonly threads: number;
  /** Repository-relative sources whose digests identify the code under test. */
  readonly codeFiles: readonly string[];
  readonly pins: FrozenControlInputs;
  readonly resultLimit: number;
  readonly candidateWidth: number;
  readonly reportedRanks: readonly number[];
}

export interface ControlReplayDeps {
  /** Called only when at least one text is missing from the vector cache. */
  createRuntime(): EmbeddingRuntime;
  /** The production scorer under test; injected so the mismatch path is testable. */
  scorePractice: typeof scoreSemanticPractice;
  readCorpus(storeRoot: string): Promise<{
    readonly identity: Readonly<Record<string, unknown>>;
    readonly practices: readonly EffectivePractice[];
  }>;
  git: GitProbe;
  now(): number;
  peakRssBytes(): number;
  environment(): RunEnvironment;
}

const queriesSchema = z.object({
  revision: z.string().min(1),
  cases: z.array(z.object({ id: z.string().min(1), query: z.string().min(1) })).min(1),
});

const cacheSchema = z.strictObject({
  cacheVersion: z.literal(1),
  identity: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.record(z.string(), z.string()),
});

export const ENCODE_TIMEOUT_MS = 60_000;
export const RUNTIME_START_TIMEOUT_MS = 60_000;
export const RUNTIME_STOP_TIMEOUT_MS = 10_000;

export async function fileSha256(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const buffer = chunk as Buffer;
      bytes += buffer.byteLength;
      hash.update(buffer);
    }
  } catch (error) {
    throw new ExperimentError("input_missing", "A frozen input file cannot be read", {
      cause: error,
    });
  }
  return { sha256: hash.digest("hex"), bytes };
}

export function requireEqual(label: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new ExperimentError(
      "input_mismatch",
      `${label} is ${String(actual)} but the frozen protocol requires ${String(expected)}`,
    );
  }
}

export function poolingOf(modelPath: string, threads: number): string {
  const args = llamaArguments(modelPath, 0, "g0", { threads });
  const value = args[args.indexOf("--pooling") + 1];
  if (value === undefined) throw new ExperimentError("run_failed", "Pooling is not declared");
  return value;
}

function encodeFloats(vector: Float32Array): string {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString("base64");
}

function decodeFloats(encoded: string, dimensions: number): Float32Array {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength !== dimensions * 4) {
    throw new ExperimentError("input_corrupt", "A cached vector has the wrong byte length");
  }
  return new Float32Array(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
}

export async function writeArtifact(
  directory: string,
  file: string,
  value: unknown,
): Promise<{ file: string; sha256: string; bytes: number }> {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  await writeFile(join(directory, file), bytes);
  return { file, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
}

export function assertOutsideRepository(repoRoot: string, outputDir: string): void {
  const relation = relative(resolve(repoRoot), resolve(outputDir));
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new ExperimentError(
      "protocol_invalid",
      "The run directory holds query text, vectors and rankings and must lie outside the repository",
    );
  }
}

export interface LoadedCache {
  readonly state: RunCost["encode"]["cacheState"];
  readonly vectors: Map<string, Float32Array>;
  readonly bytesRead: number;
}

export async function loadVectorCache(
  directory: string,
  identity: string,
  dimensions: number,
): Promise<LoadedCache> {
  const vectors = new Map<string, Float32Array>();
  let raw: Buffer;
  try {
    raw = await readFile(join(directory, VECTOR_CACHE_FILE));
  } catch {
    return { state: "absent", vectors, bytesRead: 0 };
  }
  try {
    const cache = cacheSchema.parse(JSON.parse(raw.toString("utf8")));
    if (cache.identity !== identity) {
      return { state: "rejected-identity", vectors, bytesRead: raw.byteLength };
    }
    for (const [key, encoded] of Object.entries(cache.entries)) {
      vectors.set(key, decodeFloats(encoded, dimensions));
    }
    return { state: "accepted", vectors, bytesRead: raw.byteLength };
  } catch {
    vectors.clear();
    return { state: "rejected-corrupt", vectors, bytesRead: raw.byteLength };
  }
}

export async function writeVectorCache(
  directory: string,
  identity: string,
  vectors: ReadonlyMap<string, Float32Array>,
): Promise<number> {
  const entries: Record<string, string> = {};
  for (const [key, vector] of [...vectors].sort(([left], [right]) => (left < right ? -1 : 1))) {
    entries[key] = encodeFloats(vector);
  }
  const bytes = Buffer.from(JSON.stringify({ cacheVersion: 1, identity, entries }), "utf8");
  const temporary = join(directory, `${VECTOR_CACHE_FILE}.tmp`);
  await writeFile(temporary, bytes);
  await rename(temporary, join(directory, VECTOR_CACHE_FILE));
  return bytes.byteLength;
}

/**
 * Retrieval phase of the control condition. It reads the frozen queries and
 * corpus, encodes through the production runtime, scores every eligible
 * Practice once with the production function and once with the independent
 * recomputation, and saves the full ranking. Labels are neither a parameter
 * nor an input here: the scoring phase opens them only after this phase has
 * left a complete, digest-verified manifest.
 */
export async function runControlReplay(
  config: ControlReplayConfig,
  deps: ControlReplayDeps,
): Promise<CompleteRunManifest> {
  assertOutsideRepository(config.repoRoot, config.outputDir);
  await mkdir(config.outputDir, { recursive: true });
  // A previous run must never leave a complete manifest beside new artifacts.
  await Promise.all(
    [RUN_MANIFEST_FILE, RANKING_FILE, COMPARISON_FILE].map((stale) =>
      rm(join(config.outputDir, stale), { force: true }),
    ),
  );

  const code = await readCodeIdentity(config.repoRoot, config.codeFiles, deps.git);
  let failureManifest: FailedRunManifest | undefined;
  try {
    return await retrieve(config, deps, code, (manifest) => {
      failureManifest = manifest;
    });
  } catch (error) {
    const experimentError =
      error instanceof ExperimentError
        ? error
        : new ExperimentError("run_failed", "The control replay failed", { cause: error });
    const manifest: FailedRunManifest = failureManifest ?? {
      manifestVersion: RUN_MANIFEST_VERSION,
      status: "failed",
      experiment: { id: CONTROL_EXPERIMENT_ID, condition: "control" },
      code,
      failure: { code: experimentError.code, message: experimentError.message },
    };
    await writeFile(
      join(config.outputDir, RUN_MANIFEST_FILE),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    throw experimentError;
  }
}

async function retrieve(
  config: ControlReplayConfig,
  deps: ControlReplayDeps,
  code: CodeIdentity,
  setFailure: (manifest: FailedRunManifest) => void,
): Promise<CompleteRunManifest> {
  const { pins } = config;
  const started = deps.now();
  const milliseconds = {
    inputVerification: 0,
    corpusRead: 0,
    projection: 0,
    cacheLoad: 0,
    cacheWrite: 0,
    runtimeStart: 0,
    encode: 0,
    productionScoring: 0,
    independentScoring: 0,
    ranking: 0,
    artifactWrite: 0,
    total: 0,
  };
  const lap = (() => {
    let mark = deps.now();
    return (name: Exclude<keyof typeof milliseconds, "total">) => {
      const now = deps.now();
      milliseconds[name] += now - mark;
      mark = now;
    };
  })();

  // Frozen input identities.
  requireEqual("threads", config.threads, pins.threads);
  requireEqual("embedding dimensions", EMBEDDING_MODEL.dimensions, pins.dimensions);
  const queriesBytes = await readFile(config.queriesPath).catch((cause: unknown) => {
    throw new ExperimentError("input_missing", "The frozen query file cannot be read", { cause });
  });
  const queriesSha256 = sha256Hex(queriesBytes);
  requireEqual("query file digest", queriesSha256, pins.queriesSha256);
  const model = await fileSha256(config.modelPath);
  requireEqual("model digest", model.sha256, pins.modelSha256);
  requireEqual("model size", model.bytes, pins.modelBytes);
  const nativeManifest = await fileSha256(config.nativeManifestPath);
  requireEqual("native runtime manifest digest", nativeManifest.sha256, pins.nativeManifestSha256);

  let queries: z.infer<typeof queriesSchema>;
  try {
    queries = queriesSchema.parse(JSON.parse(Buffer.from(queriesBytes).toString("utf8")));
  } catch (cause) {
    throw new ExperimentError("input_corrupt", "The frozen query file is not valid", { cause });
  }
  requireEqual("suite revision", queries.revision, pins.suiteRevision);
  requireEqual("query count", queries.cases.length, pins.caseCount);
  if (new Set(queries.cases.map((entry) => entry.id)).size !== queries.cases.length) {
    throw new ExperimentError("input_corrupt", "The frozen query file repeats a case ID");
  }
  lap("inputVerification");

  const corpus = await deps.readCorpus(config.storeRoot);
  const practices = [...corpus.practices].sort((left, right) =>
    left.practiceId < right.practiceId ? -1 : left.practiceId > right.practiceId ? 1 : 0,
  );
  requireEqual("Practice count", practices.length, pins.practiceCount);
  const corpusDigest = indexCorpusDigest(practices);
  requireEqual("corpus digest", corpusDigest, pins.corpusDigest);
  lap("corpusRead");

  // Projection: production document views and production query clauses.
  const documents = practices.map((practice) => projectSemanticPractice(practice));
  const viewCount = documents.reduce((sum, document) => sum + document.views.length, 0);
  requireEqual("view count", viewCount, pins.viewCount);
  const clausesByQuery = queries.cases.map((entry) => projectSemanticQuery(entry.query));
  const texts = new Map<string, string>();
  for (const document of documents) {
    for (const view of document.views) texts.set(sha256Hex(view.text), view.text);
  }
  for (const clauses of clausesByQuery) {
    for (const clause of clauses) texts.set(sha256Hex(clause.text), clause.text);
  }
  lap("projection");

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
  lap("cacheLoad");

  // Encoding under a fixed call budget: exactly the texts the cache cannot supply.
  const encodeBudget = missing.length;
  let encodeCalls = 0;
  let cacheBytesWritten = 0;
  if (missing.length > 0) {
    const runtime = deps.createRuntime();
    try {
      await runtime.start(
        AbortSignal.timeout(RUNTIME_START_TIMEOUT_MS),
        Date.now() + RUNTIME_START_TIMEOUT_MS,
      );
      lap("runtimeStart");
      for (const [key, text] of missing) {
        if (encodeCalls >= encodeBudget) {
          throw new ExperimentError("run_failed", "The encode call budget was exceeded");
        }
        encodeCalls += 1;
        // eslint-disable-next-line no-await-in-loop -- Encoding is sequential like production and bounded by the call budget.
        const raw = await runtime.encode(text, AbortSignal.timeout(ENCODE_TIMEOUT_MS));
        const [vector] = validateEmbeddingBatch(
          { encodingId, dimensions: pins.dimensions },
          [text],
          {
            encodingId,
            vectors: [raw],
          },
        );
        vectors.set(key, vector!);
      }
      lap("encode");
    } finally {
      await runtime.stop(Date.now() + RUNTIME_STOP_TIMEOUT_MS);
    }
    cacheBytesWritten = await writeVectorCache(config.outputDir, vectorIdentity, vectors);
    lap("cacheWrite");
  }
  const vectorOf = (text: string): Float32Array => {
    const vector = vectors.get(sha256Hex(text));
    if (vector === undefined) {
      throw new ExperimentError("run_failed", "A projected text has no vector");
    }
    return vector;
  };

  // Production-shaped inputs for the scorers.
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
  const queryVectors = clausesByQuery.map((clauses) =>
    clauses.map(
      (clause): SemanticQueryVector => ({
        viewId: clause.viewId,
        vector: vectorOf(clause.text),
        weight: clause.weight,
      }),
    ),
  );
  lap("projection");

  // One production pass and one independent pass over every query x Practice.
  const production = queryVectors.map((clauses) =>
    productionViews.map((views) => deps.scorePractice(clauses, views, pins.dimensions).score),
  );
  lap("productionScoring");
  const independent = queryVectors.map((clauses) =>
    formulaViews.map((views) =>
      recomputeControlScore(
        clauses.map((clause) => ({
          viewId: clause.viewId,
          vector: clause.vector,
          weight: clause.weight,
        })),
        views,
      ),
    ),
  );
  lap("independentScoring");

  const pairs: {
    queryId: string;
    practiceId: string;
    production: number;
    independent: number;
    absDelta: number;
  }[] = [];
  let maxAbsDelta = 0;
  let mismatchCount = 0;
  let rankOrderIdentical = true;
  const rankedCases = queries.cases.map((entry, queryIndex) => {
    const scored = practices.map((practice, practiceIndex) => ({
      practiceId: practice.practiceId,
      score: production[queryIndex]![practiceIndex]!,
    }));
    const independentScored = practices.map((practice, practiceIndex) => ({
      practiceId: practice.practiceId,
      score: independent[queryIndex]![practiceIndex]!,
    }));
    scored.forEach((item, practiceIndex) => {
      const other = independentScored[practiceIndex]!.score;
      const absDelta = Math.abs(item.score - other);
      maxAbsDelta = Math.max(maxAbsDelta, absDelta);
      if (!(absDelta <= SCORE_TOLERANCE)) mismatchCount += 1;
      pairs.push({
        queryId: entry.id,
        practiceId: item.practiceId,
        production: item.score,
        independent: other,
        absDelta,
      });
    });
    const ranked = [...scored].sort(compareScoredPractices);
    const independentRanked = [...independentScored].sort(compareScoredPractices);
    if (ranked.some((item, index) => item.practiceId !== independentRanked[index]!.practiceId)) {
      rankOrderIdentical = false;
    }
    return {
      queryId: entry.id,
      queryDigest: sha256Hex(entry.query),
      clauseCount: clausesByQuery[queryIndex]!.length,
      ranked: ranked.map((item, index) => ({
        practiceId: item.practiceId,
        score: item.score,
        rank: index + 1,
      })),
    };
  });
  lap("ranking");

  const rankingArtifact = await writeArtifact(config.outputDir, RANKING_FILE, {
    rankingFormatVersion: RANKING_FORMAT_VERSION,
    condition: "control",
    cases: rankedCases,
  });
  const comparison = {
    pairCount: pairs.length,
    maxAbsDelta,
    toleranceAbs: SCORE_TOLERANCE,
    mismatchCount,
    rankOrderIdentical,
  };
  const comparisonArtifact = await writeArtifact(config.outputDir, COMPARISON_FILE, {
    comparisonFormatVersion: 1,
    summary: comparison,
    pairs,
  });
  lap("artifactWrite");

  if (mismatchCount > 0 || !rankOrderIdentical) {
    const failed: FailedRunManifest = {
      manifestVersion: RUN_MANIFEST_VERSION,
      status: "failed",
      experiment: { id: CONTROL_EXPERIMENT_ID, condition: "control" },
      code,
      failure: {
        code: "score_mismatch",
        message: `${mismatchCount} of ${pairs.length} pairs exceed ${SCORE_TOLERANCE} (max ${maxAbsDelta}); rank order identical: ${rankOrderIdentical}`,
      },
      comparison,
      artifacts: { ranking: rankingArtifact, comparison: comparisonArtifact },
    };
    setFailure(failed);
    throw new ExperimentError("score_mismatch", failed.failure.message);
  }

  milliseconds.total = deps.now() - started;
  const manifest: CompleteRunManifest = {
    manifestVersion: RUN_MANIFEST_VERSION,
    status: "complete",
    experiment: {
      id: CONTROL_EXPERIMENT_ID,
      condition: "control",
      policyId: ROLE_POLICY_ID,
      policyDigest: ROLE_POLICY_DIGEST,
      costBudgetId: COST_BUDGET_ID,
      costBudgetDigest: COST_BUDGET_DIGEST,
    },
    code,
    inputs: {
      queries: {
        revision: queries.revision,
        caseCount: queries.cases.length,
        sha256: queriesSha256,
      },
      corpus: {
        digest: corpusDigest,
        snapshotIdentity: { ...corpus.identity },
        practiceCount: practices.length,
        viewCount,
      },
      model: { sha256: model.sha256, bytes: model.bytes },
      nativeManifestSha256: nativeManifest.sha256,
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
      formula: CONTROL_FORMULA_ID,
      resultLimit: config.resultLimit,
      candidateWidth: config.candidateWidth,
      reportedRanks: [...config.reportedRanks],
      rankingDepth: practices.length,
    },
    comparison,
    artifacts: { ranking: rankingArtifact, comparison: comparisonArtifact },
    cost: {
      condition:
        encodeCalls === 0
          ? "warm-vector-cache"
          : encodeCalls === texts.size
            ? "cold-no-vector-cache"
            : "partial-vector-cache",
      milliseconds,
      encode: {
        distinctTexts: texts.size,
        cachedTexts: texts.size - missing.length,
        calls: encodeCalls,
        budgetMaxCalls: encodeBudget,
        cacheState: cache.state,
      },
      io: {
        cacheBytesRead: cache.bytesRead,
        cacheBytesWritten,
        artifactBytesWritten: rankingArtifact.bytes + comparisonArtifact.bytes,
      },
      peakRssBytes: Math.round(deps.peakRssBytes()),
    },
    environment: deps.environment(),
  };
  await writeFile(
    join(config.outputDir, RUN_MANIFEST_FILE),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
  return manifest;
}
