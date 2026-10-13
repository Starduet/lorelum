import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { indexCorpusDigest, type EffectivePractice } from "@lorelum/engine";
import { canonicalizePractice } from "../../../../engine/src/local-store/model";
import { scoreSemanticPractice } from "../../../../engine/src/query/semantic/index/reader";
import { projectSemanticPractice } from "../../../../engine/src/query/semantic/projection";
import { EMBEDDING_MODEL, type EmbeddingRuntime } from "../../modules/embedding/model";
import { type ControlReplayConfig, type ControlReplayDeps } from "./control-replay";
import { sha256Hex } from "./digest";
import { ExperimentError, type ExperimentErrorCode } from "./experiment-error";

/** Assert that a promise rejects with an experiment error of exactly this code. */
export async function expectExperimentError(
  promise: Promise<unknown>,
  code: ExperimentErrorCode,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ExperimentError);
    expect((error as ExperimentError).code).toBe(code);
    return;
  }
  throw new Error(`expected an experiment error ${code}`);
}

/**
 * Test-only fixtures for the isolated control replay. The fake embedding gives
 * each leading word its own basis vector, so cosines are exactly 0 or 1 and a
 * ranking can be predicted by hand without any model.
 */
export const FIXTURE_WORDS = ["alpha", "beta", "gamma", "delta"] as const;

export const FIXTURE_QUERIES = {
  revision: "fixture",
  cases: [
    { id: "q-alpha", query: "alpha first" },
    { id: "q-beta", query: "beta first" },
    { id: "q-two", query: "gamma first, delta second" },
    { id: "q-none", query: "zzz unrelated" },
  ],
};

function basisIndex(word: string): number {
  return Number.parseInt(sha256Hex(word).slice(0, 8), 16) % EMBEDDING_MODEL.dimensions;
}

export function fixtureEmbedding(text: string): number[] {
  const first = text.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  const vector = new Array<number>(EMBEDDING_MODEL.dimensions).fill(0);
  vector[basisIndex(first)] = 1;
  return vector;
}

export interface FakeRuntimeProbe {
  readonly starts: number;
  readonly stops: number;
  readonly encodes: readonly string[];
}

export function createFakeRuntime(options: { failOnEncode?: boolean } = {}): {
  runtime: EmbeddingRuntime;
  probe: FakeRuntimeProbe;
} {
  const probe = { starts: 0, stops: 0, encodes: [] as string[] };
  const runtime: EmbeddingRuntime = {
    async start() {
      probe.starts += 1;
    },
    async encode(text) {
      probe.encodes.push(text);
      if (options.failOnEncode === true) throw new Error("encoder failure");
      return fixtureEmbedding(text);
    },
    async stop() {
      probe.stops += 1;
    },
    exited: new Promise<void>(() => {}),
  };
  return { runtime, probe };
}

function fixturePractice(word: string): EffectivePractice {
  const id = `platform.${word}`;
  const canonical = canonicalizePractice({
    id,
    title: `${word} title`,
    stage: "implementation",
    tech_stack: ["typescript"],
    applies_when: `${word} applies when the task is ${word}.`,
    body: `## Guidance\n\n${word} first rule.\n\n${word} second rule.`,
    severity: "warn",
  });
  return { practiceId: id, ...canonical, sources: [] };
}

export interface ControlFixture {
  readonly config: ControlReplayConfig;
  readonly deps: ControlReplayDeps;
  /** Probes of every runtime the replay created, in creation order. */
  readonly runtimes: readonly FakeRuntimeProbe[];
  readonly practices: readonly EffectivePractice[];
  readonly directories: { readonly root: string; readonly repo: string; readonly run: string };
  rewriteCodeFile(contents: string): Promise<void>;
  rewriteQueries(contents: string): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createControlFixture(
  options: { failOnEncode?: boolean } = {},
): Promise<ControlFixture> {
  const root = await mkdtemp(join(tmpdir(), "lorelum-g0-"));
  const repo = join(root, "repo");
  const run = join(root, "run");
  const inputs = join(root, "inputs");
  await mkdir(join(repo, "src"), { recursive: true });
  await mkdir(inputs, { recursive: true });
  const codeFile = "src/code.ts";
  await writeFile(join(repo, codeFile), "export const code = 1;\n", "utf8");
  const queriesPath = join(inputs, "queries.json");
  const queriesText = JSON.stringify(FIXTURE_QUERIES);
  await writeFile(queriesPath, queriesText, "utf8");
  const modelPath = join(inputs, "model.gguf");
  await writeFile(modelPath, "fixture model bytes", "utf8");
  const nativeManifestPath = join(inputs, "native.json");
  await writeFile(nativeManifestPath, "{}", "utf8");

  const practices = FIXTURE_WORDS.map(fixturePractice);
  const viewCount = practices.reduce(
    (sum, practice) => sum + projectSemanticPractice(practice).views.length,
    0,
  );
  const digest = (text: string) => createHash("sha256").update(text).digest("hex");
  const runtimes: FakeRuntimeProbe[] = [];
  let ticks = 0;
  const deps: ControlReplayDeps = {
    createRuntime() {
      const { runtime, probe } = createFakeRuntime(options);
      runtimes.push(probe);
      return runtime;
    },
    scorePractice: scoreSemanticPractice,
    async readCorpus() {
      return { identity: { generation: 1 }, practices };
    },
    git: { head: async () => "a".repeat(40), dirty: async () => false },
    now: () => (ticks += 1),
    peakRssBytes: () => 123_456,
    environment: () => ({
      platform: "test",
      arch: "test",
      bun: "test",
      cpuModel: "test",
      cpuCount: 1,
      totalMemoryBytes: 1,
    }),
  };
  const config: ControlReplayConfig = {
    repoRoot: repo,
    outputDir: run,
    queriesPath,
    storeRoot: join(root, "store"),
    modelPath,
    nativeManifestPath,
    threads: 4,
    codeFiles: [codeFile],
    pins: {
      suiteRevision: FIXTURE_QUERIES.revision,
      caseCount: FIXTURE_QUERIES.cases.length,
      queriesSha256: digest(queriesText),
      practiceCount: practices.length,
      viewCount,
      corpusDigest: indexCorpusDigest(practices),
      modelSha256: digest("fixture model bytes"),
      modelBytes: Buffer.byteLength("fixture model bytes"),
      nativeManifestSha256: digest("{}"),
      threads: 4,
      dimensions: EMBEDDING_MODEL.dimensions,
    },
    resultLimit: 5,
    candidateWidth: 20,
    reportedRanks: [1, 3, 5, 20],
  };
  return {
    config,
    deps,
    runtimes,
    practices,
    directories: { root, repo, run },
    rewriteCodeFile: (contents) => writeFile(join(repo, codeFile), contents, "utf8"),
    rewriteQueries: (contents) => writeFile(queriesPath, contents, "utf8"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
