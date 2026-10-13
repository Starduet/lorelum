import { afterEach, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createControlFixture,
  expectExperimentError,
  type ControlFixture,
} from "./control-fixtures";
import { runControlReplay } from "./control-replay";
import { scoreControlRun, SCORE_FILE, type ControlBaseline } from "./control-scoring";
import { COMPARISON_FILE, RANKING_FILE, RUN_MANIFEST_FILE } from "./manifest";

const fixtures: ControlFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((entry) => entry.cleanup()));
});

async function completedRun(): Promise<ControlFixture> {
  const created = await createControlFixture();
  fixtures.push(created);
  await runControlReplay(created.config, created.deps);
  return created;
}

function labelsFor(cases: readonly unknown[], revision = "fixture"): Uint8Array {
  return Buffer.from(JSON.stringify({ revision, cases }), "utf8");
}

/** Counts reads so a test can prove the labels stayed closed. */
function labelReader(bytes: Uint8Array) {
  const state = { reads: 0 };
  return {
    state,
    deps: {
      async readLabels() {
        state.reads += 1;
        return bytes;
      },
    },
  };
}

// Orders from the fixture: q-alpha alpha,beta,delta,gamma; q-beta beta,...; q-two delta,gamma,...; q-none alpha,beta,delta,gamma.
const CASES = [
  { id: "q-alpha", coreIds: ["platform.alpha"], forbiddenIds: ["platform.beta"] },
  { id: "q-beta", coreIds: ["platform.beta"], forbiddenIds: [] },
  { id: "q-two", coreIds: ["platform.gamma"], forbiddenIds: ["platform.delta"] },
  { id: "q-none", coreIds: ["platform.gamma"], forbiddenIds: ["platform.alpha"] },
];

describe("scoreControlRun", () => {
  test("derives hit counts, MRR, scope and forbidden-before-core from the full ranking", async () => {
    const run = await completedRun();
    const reader = labelReader(labelsFor(CASES));
    const report = await scoreControlRun(run.directories.run, reader.deps);
    // core ranks 1, 1, 2, 4.
    expect(report.cases.map((entry) => entry.coreRank)).toEqual([1, 1, 2, 4]);
    expect(report.metrics.hitAt).toEqual({ "1": 2, "3": 3, "5": 4, "20": 4 });
    expect(report.metrics.mrr).toBeCloseTo((1 + 1 + 1 / 2 + 1 / 4) / 4, 12);
    // q-alpha: forbidden beta is rank 2, inside the result limit. q-two: forbidden delta is rank 1.
    // q-none: forbidden alpha is rank 1, before the core at rank 4.
    expect(report.metrics.scopeErrorCases).toBe(3);
    expect(report.metrics.forbiddenBeforeCoreCases).toBe(2);
    expect(report.cases[0]).toMatchObject({ scopeError: true, forbiddenBeforeCore: false });
    expect(report.cases[2]).toMatchObject({ scopeError: true, forbiddenBeforeCore: true });
    const written = JSON.parse(await readFile(join(run.directories.run, SCORE_FILE), "utf8"));
    expect(written.rankingSha256).toBe(report.rankingSha256);
    expect(written.labelsSha256).toBe(report.labelsSha256);
  });

  test("reports whether the frozen baseline was reproduced without turning a difference into a throw", async () => {
    const run = await completedRun();
    const matching: ControlBaseline = {
      hitAt1: 2,
      hitAt3: 3,
      hitAt5: 4,
      hitAt20: 4,
      mrr: 0.6875,
      scopeErrorCases: 3,
      forbiddenBeforeCoreCases: 2,
    };
    const reproduced = await scoreControlRun(
      run.directories.run,
      labelReader(labelsFor(CASES)).deps,
      matching,
    );
    expect(reproduced.baseline).toMatchObject({ reproduced: true, differences: [] });
    const different = await scoreControlRun(
      run.directories.run,
      labelReader(labelsFor(CASES)).deps,
      { ...matching, hitAt1: 3, scopeErrorCases: 0 },
    );
    expect(different.baseline.reproduced).toBe(false);
    expect(different.baseline.differences).toHaveLength(2);
  });

  test("takes the worst core rank so hit@k means every core is present", async () => {
    const run = await completedRun();
    const report = await scoreControlRun(
      run.directories.run,
      labelReader(
        labelsFor([
          { id: "q-alpha", coreIds: ["platform.alpha", "platform.gamma"], forbiddenIds: [] },
          ...CASES.slice(1),
        ]),
      ).deps,
    );
    expect(report.cases[0]?.coreRank).toBe(4);
  });
});

describe("stage isolation between retrieval and labels", () => {
  test("a run without a manifest is never scored and labels stay closed", async () => {
    const run = await completedRun();
    await rm(join(run.directories.run, RUN_MANIFEST_FILE));
    const reader = labelReader(labelsFor(CASES));
    await expectExperimentError(scoreControlRun(run.directories.run, reader.deps), "input_missing");
    expect(reader.state.reads).toBe(0);
  });

  test("a failed run is refused as a stage violation, not scored as misses", async () => {
    const created = await createControlFixture();
    fixtures.push(created);
    await created.rewriteQueries("{}");
    await expectExperimentError(runControlReplay(created.config, created.deps), "input_mismatch");
    const reader = labelReader(labelsFor(CASES));
    await expectExperimentError(
      scoreControlRun(created.directories.run, reader.deps),
      "stage_violation",
    );
    expect(reader.state.reads).toBe(0);
  });

  test("a ranking changed after the run no longer matches its digest and labels stay closed", async () => {
    const run = await completedRun();
    const path = join(run.directories.run, RANKING_FILE);
    const original = await readFile(path, "utf8");
    await writeFile(path, original.replace("platform.alpha", "platform.alphb"), "utf8");
    const reader = labelReader(labelsFor(CASES));
    await expectExperimentError(scoreControlRun(run.directories.run, reader.deps), "input_corrupt");
    expect(reader.state.reads).toBe(0);
  });

  test("a missing comparison artifact blocks scoring", async () => {
    const run = await completedRun();
    await rm(join(run.directories.run, COMPARISON_FILE));
    const reader = labelReader(labelsFor(CASES));
    await expectExperimentError(scoreControlRun(run.directories.run, reader.deps), "input_missing");
    expect(reader.state.reads).toBe(0);
  });
});

describe("label protocol errors are not retrieval misses", () => {
  test("rejects labels for a different suite revision", async () => {
    const run = await completedRun();
    await expectExperimentError(
      scoreControlRun(run.directories.run, labelReader(labelsFor(CASES, "other")).deps),
      "input_mismatch",
    );
  });

  test("rejects labels that miss, repeat or add a query", async () => {
    const run = await completedRun();
    await expectExperimentError(
      scoreControlRun(run.directories.run, labelReader(labelsFor(CASES.slice(1))).deps),
      "protocol_invalid",
    );
    await expectExperimentError(
      scoreControlRun(run.directories.run, labelReader(labelsFor([...CASES, CASES[0]])).deps),
      "protocol_invalid",
    );
    await expectExperimentError(
      scoreControlRun(
        run.directories.run,
        labelReader(
          labelsFor([
            ...CASES.slice(1),
            { id: "q-extra", coreIds: ["platform.alpha"], forbiddenIds: [] },
          ]),
        ).deps,
      ),
      "protocol_invalid",
    );
  });

  test("rejects a label that names a Practice absent from the corpus", async () => {
    const run = await completedRun();
    await expectExperimentError(
      scoreControlRun(
        run.directories.run,
        labelReader(
          labelsFor([
            { id: "q-alpha", coreIds: ["platform.missing"], forbiddenIds: [] },
            ...CASES.slice(1),
          ]),
        ).deps,
      ),
      "protocol_invalid",
    );
  });

  test("rejects an unreadable label file as corrupt input", async () => {
    const run = await completedRun();
    await expectExperimentError(
      scoreControlRun(run.directories.run, labelReader(Buffer.from("not json")).deps),
      "input_corrupt",
    );
  });
});
