import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createControlFixture,
  expectExperimentError,
  FIXTURE_QUERIES,
  type ControlFixture,
} from "./control-fixtures";
import { sha256Hex } from "./digest";
import {
  ROLE_CONDITION_IDS,
  readRoleRunManifest,
  ROLE_RUN_MANIFEST_FILE,
} from "./role-run-manifest";
import { rankingFileOf, runRoleReplay, type RoleReplayConfig } from "./role-replay";
import { readVerifiedRoleRun, scoreRoleRun } from "./role-scoring";

const fixtures: ControlFixture[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((entry) => entry.cleanup()));
});

interface Annotation {
  role: string;
  text: string;
  start: number;
  end: number;
  group?: string;
}

const PRIMARY: Record<string, Annotation[]> = {
  "q-alpha": [{ role: "intent", text: "alpha", start: 0, end: 5 }],
  "q-beta": [{ role: "intent", text: "beta", start: 0, end: 4 }],
  "q-two": [
    { role: "intent", text: "gamma", start: 0, end: 5, group: "one" },
    { role: "intent", text: "delta", start: 13, end: 18, group: "two" },
  ],
  // No scorable role: the query must fall back to the production clause path.
  "q-none": [],
};

async function writeRoleSet(directory: string, set: Record<string, Annotation[]>): Promise<void> {
  await mkdir(directory, { recursive: true });
  for (const entry of FIXTURE_QUERIES.cases) {
    await writeFile(
      join(directory, `${entry.id}.json`),
      JSON.stringify({
        formatVersion: 1,
        spanUnit: "utf16-code-unit",
        queryId: entry.id,
        queryDigest: sha256Hex(entry.query),
        analysisVersion: "manual/test",
        analysisKind: "manual",
        roles: (set[entry.id] ?? []).map((annotation) => ({
          role: annotation.role,
          ...(annotation.group === undefined ? {} : { actionGroup: annotation.group }),
          text: annotation.text,
          spans: [{ start: annotation.start, end: annotation.end }],
          restated: false,
          inference: "test",
        })),
      }),
      "utf8",
    );
  }
}

async function setup(
  restated = false,
): Promise<{ fixture: ControlFixture; config: RoleReplayConfig }> {
  const fixture = await createControlFixture();
  fixtures.push(fixture);
  const { config, directories } = fixture;
  const primary = join(directories.root, "roles");
  await writeRoleSet(primary, PRIMARY);
  const restatedDir = join(directories.root, "roles-restated");
  if (restated) await writeRoleSet(restatedDir, PRIMARY);
  return {
    fixture,
    config: {
      repoRoot: config.repoRoot,
      outputDir: config.outputDir,
      queriesPath: config.queriesPath,
      queries: {
        revision: config.pins.suiteRevision,
        caseCount: config.pins.caseCount,
        sha256: config.pins.queriesSha256,
        usage: "development",
      },
      storeRoot: config.storeRoot,
      modelPath: config.modelPath,
      nativeManifestPath: config.nativeManifestPath,
      threads: config.threads,
      codeFiles: config.codeFiles,
      pins: config.pins,
      roleSets: { primary, ...(restated ? { restated: restatedDir } : {}) },
      provenance: { independentOfTargets: false, annotator: "test", disclosure: "test annotator" },
      resultLimit: config.resultLimit,
      reportedRanks: config.reportedRanks,
    },
  };
}

const DEV_LABELS = JSON.stringify({
  revision: "fixture",
  cases: [
    { id: "q-alpha", coreIds: ["platform.alpha"], forbiddenIds: ["platform.beta"] },
    { id: "q-beta", coreIds: ["platform.beta"], forbiddenIds: [] },
    { id: "q-two", coreIds: ["platform.gamma", "platform.delta"], forbiddenIds: [] },
    { id: "q-none", coreIds: ["platform.alpha"], forbiddenIds: [] },
  ],
});

describe("runRoleReplay", () => {
  test("ranks every Practice under every registered condition before any K is applied", async () => {
    const { fixture, config } = await setup(true);
    const manifest = await runRoleReplay(config, fixture.deps);
    expect(manifest.conditions.map((condition) => condition.id)).toEqual([...ROLE_CONDITION_IDS]);
    const run = await readVerifiedRoleRun(config.outputDir);
    for (const [, byQuery] of run.rankedIds) {
      for (const ids of byQuery.values()) expect(ids).toHaveLength(fixture.practices.length);
    }
    expect(run.rankedIds.get("Q")!.get("q-alpha")![0]).toBe("platform.alpha");
    expect(run.rankedIds.get("Q+I")!.get("q-beta")![0]).toBe("platform.beta");
    expect(manifest.controlComparison).toMatchObject({ pairCount: 16, mismatchCount: 0 });
  });

  test("a query with no scorable role takes the production path and is counted, not dropped", async () => {
    const { fixture, config } = await setup();
    const manifest = await runRoleReplay(config, fixture.deps);
    const run = await readVerifiedRoleRun(config.outputDir);
    const q = manifest.conditions.find((condition) => condition.id === "Q")!;
    expect(q.fallbackQueries).toBe(1);
    expect(run.rankedIds.get("Q")!.get("q-none")).toEqual(
      run.rankedIds.get("control")!.get("q-none")!,
    );
    expect(manifest.conditions.some((condition) => condition.id === "Q-restated")).toBe(false);
    for (const condition of manifest.conditions) {
      expect(condition.maxTextsPerQuery).toBeLessThanOrEqual(8);
    }
  });

  test("a query without a role sample file is an input error, never a silent fallback", async () => {
    const { fixture, config } = await setup();
    await writeFile(join(config.roleSets.primary, "q-beta.json"), "not json", "utf8");
    await expectExperimentError(runRoleReplay(config, fixture.deps), "input_missing");
    const manifest = await readRoleRunManifest(config.outputDir);
    expect(manifest.status).toBe("failed");
    await expectExperimentError(readVerifiedRoleRun(config.outputDir), "stage_violation");
  });

  test("an automatic analysis is refused: G1 tests manual roles only", async () => {
    const { fixture, config } = await setup();
    const path = join(config.roleSets.primary, "q-alpha.json");
    const sample = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...sample, analysisKind: "automatic" }), "utf8");
    await expectExperimentError(runRoleReplay(config, fixture.deps), "protocol_invalid");
  });

  test("an encoder failure ends the run as failed and leaves nothing scoreable", async () => {
    const failing = await createControlFixture({ failOnEncode: true });
    fixtures.push(failing);
    const { config } = await setup();
    await expectExperimentError(runRoleReplay(config, failing.deps), "run_failed");
    await expectExperimentError(readVerifiedRoleRun(config.outputDir), "stage_violation");
  });

  test("the run is deterministic", async () => {
    const { fixture, config } = await setup();
    const first = await runRoleReplay(config, fixture.deps);
    const second = await runRoleReplay(config, fixture.deps);
    expect(second.conditions.map((condition) => condition.ranking.sha256)).toEqual(
      first.conditions.map((condition) => condition.ranking.sha256),
    );
  });

  test("it refuses a run directory inside the repository", async () => {
    const { fixture, config } = await setup();
    await expectExperimentError(
      runRoleReplay({ ...config, outputDir: join(config.repoRoot, "run") }, fixture.deps),
      "protocol_invalid",
    );
  });
});

describe("scoreRoleRun", () => {
  async function replayed(): Promise<{
    config: RoleReplayConfig;
    queries: () => Promise<Uint8Array>;
  }> {
    const { fixture, config } = await setup();
    await runRoleReplay(config, fixture.deps);
    return { config, queries: () => readFile(config.queriesPath) };
  }

  test("reads labels only after the rankings verify, and scores every condition", async () => {
    const { config, queries } = await replayed();
    let reads = 0;
    const report = await scoreRoleRun(config.outputDir, {
      readQueries: queries,
      readDevelopmentLabels: async () => {
        reads += 1;
        return Buffer.from(DEV_LABELS);
      },
      pilotLabelsIndependent: false,
    });
    expect(reads).toBe(1);
    const control = report.conditions.find((condition) => condition.id === "control")!;
    // q-two needs both cores, so its core rank is 2.
    expect(control.development!.hitAt).toMatchObject({ "1": 3, "3": 4, "5": 4 });
    expect(control.development!.mrr).toBeCloseTo(0.875, 12);
    expect(control.development!.versusControl).toEqual({
      improved: [],
      regressed: [],
      unchanged: 4,
    });
    // The fixture has four queries and no pilot: nothing can be concluded.
    for (const gate of report.gates) expect(gate.verdict).not.toBe("pass");
  });

  test("tampered rankings and failed runs never reach the labels", async () => {
    const { config, queries } = await replayed();
    let reads = 0;
    const deps = {
      readQueries: queries,
      readDevelopmentLabels: async () => {
        reads += 1;
        return Buffer.from(DEV_LABELS);
      },
      pilotLabelsIndependent: false,
    };
    const file = join(config.outputDir, rankingFileOf("Q"));
    await writeFile(file, `${await readFile(file, "utf8")} `, "utf8");
    await expectExperimentError(scoreRoleRun(config.outputDir, deps), "input_corrupt");

    const manifestPath = join(config.outputDir, ROLE_RUN_MANIFEST_FILE);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    await writeFile(
      manifestPath,
      JSON.stringify({
        manifestVersion: 1,
        status: "failed",
        experiment: { id: "x" },
        code: manifest.code,
        failure: { code: "run_failed", message: "boom" },
      }),
      "utf8",
    );
    await expectExperimentError(scoreRoleRun(config.outputDir, deps), "stage_violation");
    expect(reads).toBe(0);
  });

  test("labels that do not describe exactly the ranked queries are a protocol error, not a miss", async () => {
    const { config, queries } = await replayed();
    const partial = JSON.stringify({
      revision: "fixture",
      cases: [{ id: "q-alpha", coreIds: ["platform.alpha"], forbiddenIds: [] }],
    });
    await expectExperimentError(
      scoreRoleRun(config.outputDir, {
        readQueries: queries,
        readDevelopmentLabels: async () => Buffer.from(partial),
        pilotLabelsIndependent: false,
      }),
      "protocol_invalid",
    );
  });

  test("the query file must be the one the run used", async () => {
    const { config } = await replayed();
    await expectExperimentError(
      scoreRoleRun(config.outputDir, {
        readQueries: async () => Buffer.from("{}"),
        readDevelopmentLabels: async () => Buffer.from(DEV_LABELS),
        pilotLabelsIndependent: false,
      }),
      "input_mismatch",
    );
  });

  test("pilot labels are checked against the frozen corpus digests before any success is counted", async () => {
    const { fixture, config } = await setup();
    await runRoleReplay(config, fixture.deps);
    const run = await readVerifiedRoleRun(config.outputDir);
    const alpha = run.practiceDigests.get("platform.alpha")!;
    const labelFor = (id: string, query: string, digest: string) =>
      id === "q-alpha"
        ? {
            protocolVersion: 2,
            queryId: id,
            queryDigest: sha256Hex(query),
            review: {
              reviewers: 1,
              blindToSystem: true,
              blindToRanking: true,
              disclosure: "single test reviewer",
            },
            noRelevantTarget: false,
            items: [
              {
                practiceId: "platform.alpha",
                contentDigest: digest,
                class: "required-core",
                rationale: "r",
              },
            ],
          }
        : {
            protocolVersion: 2,
            queryId: id,
            queryDigest: sha256Hex(query),
            review: {
              reviewers: 1,
              blindToSystem: true,
              blindToRanking: true,
              disclosure: "single test reviewer",
            },
            noRelevantTarget: true,
            items: [],
          };
    const score = (digest: string) =>
      scoreRoleRun(config.outputDir, {
        readQueries: () => readFile(config.queriesPath),
        readPilotLabel: async (id) =>
          labelFor(id, FIXTURE_QUERIES.cases.find((entry) => entry.id === id)!.query, digest),
        pilotLabelsIndependent: false,
      });
    const report = await score(alpha);
    const control = report.conditions.find((condition) => condition.id === "control")!.pilot!;
    expect(control).toMatchObject({
      queryCount: 4,
      targetedQueries: 1,
      success: 1,
      forbiddenQueries: 0,
    });
    // Single-reviewer, non-independent pilot: never a pass.
    for (const gate of report.gates) expect(gate.verdict).not.toBe("pass");
    await expectExperimentError(score("0".repeat(64)), "protocol_invalid");
  });
});
