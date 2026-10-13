import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { ROLE_POLICY_DIGEST } from "./candidate-policy";
import { COST_BUDGET_DIGEST } from "./cost-budget";
import {
  createControlFixture,
  expectExperimentError,
  FIXTURE_WORDS,
  fixtureEmbedding,
  type ControlFixture,
} from "./control-fixtures";
import { runControlReplay, VECTOR_CACHE_FILE } from "./control-replay";
import { COMPARISON_FILE, parseRunManifest, RANKING_FILE, RUN_MANIFEST_FILE } from "./manifest";

const fixtures: ControlFixture[] = [];

async function fixture(options: { failOnEncode?: boolean } = {}): Promise<ControlFixture> {
  const created = await createControlFixture(options);
  fixtures.push(created);
  return created;
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((entry) => entry.cleanup()));
});

const rankingFile = z.object({
  cases: z.array(
    z.object({
      queryId: z.string(),
      ranked: z.array(z.object({ practiceId: z.string() })),
    }),
  ),
});
const comparisonFile = z.object({ pairs: z.array(z.unknown()) });

async function readJson(directory: string, file: string): Promise<unknown> {
  return JSON.parse(await readFile(join(directory, file), "utf8"));
}

test("fixture words own distinct basis vectors", () => {
  const indexes = FIXTURE_WORDS.map((word) => fixtureEmbedding(word).indexOf(1));
  expect(new Set(indexes).size).toBe(FIXTURE_WORDS.length);
});

describe("runControlReplay", () => {
  test("ranks every eligible Practice before any K is applied and compares every pair", async () => {
    const { config, deps, practices, directories } = await fixture();
    const manifest = await runControlReplay(config, deps);

    const ranking = rankingFile.parse(await readJson(directories.run, RANKING_FILE));
    const byQuery = new Map(
      ranking.cases.map((entry) => [entry.queryId, entry.ranked.map((item) => item.practiceId)]),
    );
    // K is 5 but only four Practices exist; a K-truncated artifact would hide the tail.
    expect(manifest.scoring.rankingDepth).toBe(practices.length);
    for (const ids of byQuery.values()) expect(ids).toHaveLength(practices.length);
    expect(byQuery.get("q-alpha")?.[0]).toBe("platform.alpha");
    expect(byQuery.get("q-beta")?.[0]).toBe("platform.beta");
    // Two clauses tie exactly; the Practice ID decides.
    expect(byQuery.get("q-two")?.slice(0, 2)).toEqual(["platform.delta", "platform.gamma"]);
    // Nothing matches: every score ties and the order is the Practice ID order.
    expect(byQuery.get("q-none")).toEqual([
      "platform.alpha",
      "platform.beta",
      "platform.delta",
      "platform.gamma",
    ]);

    const comparison = comparisonFile.parse(await readJson(directories.run, COMPARISON_FILE));
    expect(comparison.pairs).toHaveLength(config.pins.caseCount * practices.length);
    expect(manifest.comparison).toMatchObject({
      pairCount: config.pins.caseCount * practices.length,
      mismatchCount: 0,
      rankOrderIdentical: true,
    });
    expect(manifest.comparison.maxAbsDelta).toBeLessThanOrEqual(1e-6);
  });

  test("writes a manifest that records identity, encoding, budget and cost", async () => {
    const { config, deps, directories } = await fixture();
    const manifest = await runControlReplay(config, deps);
    const onDisk = parseRunManifest(await readJson(directories.run, RUN_MANIFEST_FILE));
    expect(onDisk).toEqual(manifest);
    expect(manifest.code.commit).toBe("a".repeat(40));
    expect(manifest.experiment).toMatchObject({
      condition: "control",
      policyDigest: ROLE_POLICY_DIGEST,
      costBudgetDigest: COST_BUDGET_DIGEST,
    });
    expect(manifest.code.files.map((file) => file.path)).toEqual(["src/code.ts"]);
    expect(manifest.encoding).toMatchObject({
      pooling: "cls",
      normalization: "l2",
      threads: 4,
      dimensions: 384,
    });
    expect(manifest.scoring).toMatchObject({
      resultLimit: 5,
      candidateWidth: 20,
      reportedRanks: [1, 3, 5, 20],
    });
    expect(manifest.cost.condition).toBe("cold-no-vector-cache");
    expect(manifest.cost.encode.calls).toBe(manifest.cost.encode.distinctTexts);
    expect(manifest.cost.encode.calls).toBeLessThanOrEqual(manifest.cost.encode.budgetMaxCalls);
    expect(manifest.cost.peakRssBytes).toBe(123_456);
    expect(JSON.stringify(manifest)).not.toContain(directories.root.replaceAll("\\", "\\\\"));
  });

  test("a second run reuses the verified vector cache without starting a runtime", async () => {
    const { config, deps, runtimes } = await fixture();
    const cold = await runControlReplay(config, deps);
    const warm = await runControlReplay(config, deps);
    expect(runtimes).toHaveLength(1);
    expect(warm.cost.condition).toBe("warm-vector-cache");
    expect(warm.cost.encode).toMatchObject({ calls: 0, cacheState: "accepted" });
    expect(warm.artifacts.ranking.sha256).toBe(cold.artifacts.ranking.sha256);
  });

  test("a changed code identity invalidates the cache and re-encodes", async () => {
    const { config, deps, runtimes, rewriteCodeFile } = await fixture();
    await runControlReplay(config, deps);
    await rewriteCodeFile("export const code = 2;\n");
    const rerun = await runControlReplay(config, deps);
    expect(runtimes).toHaveLength(2);
    expect(rerun.cost.encode.cacheState).toBe("rejected-identity");
    expect(rerun.cost.condition).toBe("cold-no-vector-cache");
  });

  test("a corrupt cache is discarded and rebuilt instead of trusted", async () => {
    const { config, deps, runtimes, directories } = await fixture();
    await runControlReplay(config, deps);
    await writeFile(join(directories.run, VECTOR_CACHE_FILE), "{ not json", "utf8");
    const rerun = await runControlReplay(config, deps);
    expect(runtimes).toHaveLength(2);
    expect(rerun.cost.encode.cacheState).toBe("rejected-corrupt");
  });

  test("a changed input is an input mismatch recorded as a failed run, not a miss", async () => {
    const { config, deps, directories, rewriteQueries } = await fixture();
    await rewriteQueries(
      JSON.stringify({ revision: "fixture", cases: [{ id: "x", query: "changed" }] }),
    );
    await expectExperimentError(runControlReplay(config, deps), "input_mismatch");
    const manifest = parseRunManifest(await readJson(directories.run, RUN_MANIFEST_FILE));
    expect(manifest.status).toBe("failed");
    if (manifest.status === "failed") expect(manifest.failure.code).toBe("input_mismatch");
    await expect(readFile(join(directories.run, RANKING_FILE))).rejects.toThrow();
  });

  test("a corpus that differs from the frozen identity stops the run", async () => {
    const { config, deps } = await fixture();
    await expectExperimentError(
      runControlReplay({ ...config, pins: { ...config.pins, corpusDigest: "0".repeat(64) } }, deps),
      "input_mismatch",
    );
    await expectExperimentError(
      runControlReplay(
        { ...config, pins: { ...config.pins, viewCount: config.pins.viewCount + 1 } },
        deps,
      ),
      "input_mismatch",
    );
  });

  test("an encoder failure is a failed run and the runtime is still stopped", async () => {
    const { config, deps, runtimes, directories } = await fixture({ failOnEncode: true });
    await expectExperimentError(runControlReplay(config, deps), "run_failed");
    expect(runtimes[0]?.stops).toBe(1);
    const manifest = parseRunManifest(await readJson(directories.run, RUN_MANIFEST_FILE));
    expect(manifest.status).toBe("failed");
  });

  test("a production score that disagrees with the recomputation fails the run and keeps evidence", async () => {
    const { config, deps, directories } = await fixture();
    const skewed = {
      ...deps,
      scorePractice: ((...args: Parameters<typeof deps.scorePractice>) => {
        const scored = deps.scorePractice(...args);
        return { ...scored, score: scored.score + 1e-3 };
      }) as typeof deps.scorePractice,
    };
    await expectExperimentError(runControlReplay(config, skewed), "score_mismatch");
    const manifest = parseRunManifest(await readJson(directories.run, RUN_MANIFEST_FILE));
    expect(manifest.status).toBe("failed");
    if (manifest.status === "failed") {
      expect(manifest.comparison?.mismatchCount).toBeGreaterThan(0);
      expect(manifest.comparison?.maxAbsDelta).toBeGreaterThan(1e-6);
    }
  });

  test("a stale complete manifest cannot survive a run that fails", async () => {
    const { config, deps, directories, rewriteQueries } = await fixture();
    await runControlReplay(config, deps);
    await rewriteQueries("{}");
    await expectExperimentError(runControlReplay(config, deps), "input_mismatch");
    const manifest = parseRunManifest(await readJson(directories.run, RUN_MANIFEST_FILE));
    expect(manifest.status).toBe("failed");
  });

  test("refuses a run directory inside the repository", async () => {
    const { config, deps, directories } = await fixture();
    const inside = join(directories.repo, "runs");
    await mkdir(inside, { recursive: true });
    await expectExperimentError(
      runControlReplay({ ...config, outputDir: inside }, deps),
      "protocol_invalid",
    );
  });
});
