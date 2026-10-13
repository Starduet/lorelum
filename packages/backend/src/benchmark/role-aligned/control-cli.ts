import { execFile } from "node:child_process";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";

import { createLocalStore } from "@lorelum/engine";
import { scoreSemanticPractice } from "../../../../engine/src/query/semantic/index/reader";
import { createEmbeddingProcess } from "../../runtime/embedding-process";
import {
  runControlReplay,
  type ControlReplayConfig,
  type ControlReplayDeps,
  type FrozenControlInputs,
} from "./control-replay";
import { scoreControlRun } from "./control-scoring";
import { ExperimentError } from "./experiment-error";
import { FROZEN_CONTROL_INPUTS, FROZEN_SCORER } from "./frozen-inputs";

const run = promisify(execFile);
export const REPO_ROOT = resolve(import.meta.dir, "../../../../..");
const TOOL_DIRECTORY = "packages/backend/src/benchmark/role-aligned";

/** Sources whose bytes decide what the control computes; their digests enter every manifest. */
export const CODE_UNDER_TEST = [
  "packages/engine/src/query/semantic/projection.ts",
  "packages/engine/src/query/semantic/query-views.ts",
  "packages/engine/src/query/semantic/profile.ts",
  "packages/engine/src/query/semantic/encoding.ts",
  "packages/engine/src/query/semantic/index/reader.ts",
  "packages/backend/src/runtime/llama-options.ts",
  "packages/backend/src/runtime/embedding-process.ts",
  "packages/backend/src/runtime/llama-client.ts",
  "packages/backend/src/modules/embedding/model.ts",
];

export async function toolSources(): Promise<string[]> {
  const entries = await readdir(join(REPO_ROOT, TOOL_DIRECTORY));
  return entries
    .filter(
      (name) =>
        name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "control-fixtures.ts",
    )
    .sort()
    .map((name) => `${TOOL_DIRECTORY}/${name}`);
}

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run("git", args, { cwd: REPO_ROOT });
  return stdout.trim();
}

export function replayDeps(modelPath: string, threads: number): ControlReplayDeps {
  const store = createLocalStore();
  return {
    createRuntime: () => createEmbeddingProcess({ modelPath, threads }),
    scorePractice: scoreSemanticPractice,
    async readCorpus(storeRoot) {
      const snapshot = await store.readEffectivePracticeSnapshot({ rootPath: storeRoot });
      return { identity: { ...snapshot.identity }, practices: snapshot.practices };
    },
    git: {
      head: () => git("rev-parse", "HEAD"),
      dirty: async (files) => (await git("status", "--porcelain", "--", ...files)).length > 0,
    },
    now: () => performance.now(),
    // `maxRSS` is reported in kilobytes by process.resourceUsage().
    peakRssBytes: () => process.resourceUsage().maxRSS * 1024,
    environment: () => ({
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      cpuModel: cpus()[0]?.model ?? "unknown",
      cpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    }),
  };
}

const USAGE = `usage:
  control-cli.ts replay --out <dir> --queries <queries.json> --store <store root> --model <model.gguf> --native-manifest <manifest.json> [--threads 4]
  control-cli.ts score  --out <dir> --labels <labels.json>`;

async function main(): Promise<void> {
  const [command, ...rest] = Bun.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      queries: { type: "string" },
      store: { type: "string" },
      model: { type: "string" },
      "native-manifest": { type: "string" },
      labels: { type: "string" },
      threads: { type: "string" },
      "queries-sha256": { type: "string" },
      "queries-revision": { type: "string" },
      "case-count": { type: "string" },
    },
  });
  const out = values.out;
  if (out === undefined) throw new Error(USAGE);

  if (command === "replay") {
    const { queries, store, model } = values;
    const nativeManifest = values["native-manifest"];
    if (
      queries === undefined ||
      store === undefined ||
      model === undefined ||
      nativeManifest === undefined
    ) {
      throw new Error(USAGE);
    }
    const threads = Number(values.threads ?? FROZEN_CONTROL_INPUTS.threads);
    // Frozen G0 identity by default; a protocol-frozen query set supplies all three values explicitly.
    const queryIdentityGiven =
      values["queries-sha256"] !== undefined ||
      values["queries-revision"] !== undefined ||
      values["case-count"] !== undefined;
    if (
      queryIdentityGiven &&
      (values["queries-sha256"] === undefined ||
        values["queries-revision"] === undefined ||
        values["case-count"] === undefined)
    ) {
      throw new Error(USAGE);
    }
    const pins: FrozenControlInputs = queryIdentityGiven
      ? {
          ...FROZEN_CONTROL_INPUTS,
          queriesSha256: values["queries-sha256"]!,
          suiteRevision: values["queries-revision"]!,
          caseCount: Number(values["case-count"]),
        }
      : FROZEN_CONTROL_INPUTS;
    const config: ControlReplayConfig = {
      repoRoot: REPO_ROOT,
      outputDir: resolve(out),
      queriesPath: resolve(queries),
      storeRoot: resolve(store),
      modelPath: resolve(model),
      nativeManifestPath: resolve(nativeManifest),
      threads,
      codeFiles: [...CODE_UNDER_TEST, ...(await toolSources())],
      pins,
      resultLimit: FROZEN_SCORER.resultLimit,
      candidateWidth: FROZEN_SCORER.candidateWidth,
      reportedRanks: FROZEN_SCORER.reportedRanks,
    };
    const manifest = await runControlReplay(config, replayDeps(config.modelPath, threads));
    // Machine-specific paths stay beside the run, never inside the manifest.
    await writeFile(
      join(config.outputDir, "local-environment.json"),
      JSON.stringify(
        {
          queriesPath: config.queriesPath,
          storeRoot: config.storeRoot,
          modelPath: config.modelPath,
          nativeManifestPath: config.nativeManifestPath,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(
      JSON.stringify(
        { status: manifest.status, comparison: manifest.comparison, cost: manifest.cost },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "score") {
    const labels = values.labels;
    if (labels === undefined) throw new Error(USAGE);
    const report = await scoreControlRun(resolve(out), {
      readLabels: async () => readFile(resolve(labels)),
    });
    console.log(JSON.stringify({ metrics: report.metrics, baseline: report.baseline }, null, 2));
    if (!report.baseline.reproduced) process.exitCode = 2;
    return;
  }
  throw new Error(USAGE);
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    if (error instanceof ExperimentError) {
      console.error(JSON.stringify({ experimentError: error.code, message: error.message }));
    } else {
      console.error(error);
    }
    process.exitCode = 1;
  });
}
