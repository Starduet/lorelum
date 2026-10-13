import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { CODE_UNDER_TEST, REPO_ROOT, replayDeps, toolSources } from "./control-cli";
import { authorRoleSamples, type AuthoringEntry } from "./role-authoring";
import { ExperimentError } from "./experiment-error";
import { FROZEN_CONTROL_INPUTS, FROZEN_SCORER } from "./frozen-inputs";
import { runRoleReplay, type RoleReplayConfig } from "./role-replay";
import { scoreRoleRun } from "./role-scoring";

const USAGE = `usage:
  role-cli.ts author --queries <queries.json> --spec <spec.json> --out <primary dir> --out-restated <restated dir>
      spec: { "<queryId>": [[role, [fragments], restatement, actionGroup?], ...] }; keep it outside the repository
  role-cli.ts replay --out <dir> --queries <queries.json> --usage development|pilot --store <root> --model <model.gguf> --native-manifest <manifest.json>
      --roles <dir> [--roles-restated <dir>] --annotator <name> --disclosure <text> [--roles-independent]
      [--queries-sha256 <hex> --queries-revision <rev> --case-count <n>]   (required for pilot; development defaults to the frozen v2 set)
  role-cli.ts score --out <dir> --queries <queries.json> [--dev-labels <labels.json>] [--pilot-labels <dir>] [--labels-independent]`;

async function main(): Promise<void> {
  const [command, ...rest] = Bun.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      out: { type: "string" },
      queries: { type: "string" },
      usage: { type: "string" },
      store: { type: "string" },
      model: { type: "string" },
      "native-manifest": { type: "string" },
      roles: { type: "string" },
      "roles-restated": { type: "string" },
      annotator: { type: "string" },
      disclosure: { type: "string" },
      "roles-independent": { type: "boolean" },
      "queries-sha256": { type: "string" },
      "queries-revision": { type: "string" },
      "case-count": { type: "string" },
      "dev-labels": { type: "string" },
      "pilot-labels": { type: "string" },
      "labels-independent": { type: "boolean" },
      spec: { type: "string" },
      "out-restated": { type: "string" },
    },
  });
  const { out, queries } = values;
  if (out === undefined || queries === undefined) throw new Error(USAGE);

  if (command === "author") {
    const { spec } = values;
    const outRestated = values["out-restated"];
    if (spec === undefined || outRestated === undefined) throw new Error(USAGE);
    const cases = (
      JSON.parse(await readFile(resolve(queries), "utf8")) as {
        cases: { id: string; query: string }[];
      }
    ).cases;
    const specs = JSON.parse(await readFile(resolve(spec), "utf8")) as Record<
      string,
      [AuthoringEntry["role"], string[], string, string?][]
    >;
    const missing = cases.filter((entry) => specs[entry.id] === undefined).map((entry) => entry.id);
    const extra = Object.keys(specs).filter((id) => !cases.some((entry) => entry.id === id));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`spec does not match the queries: missing ${missing}, unknown ${extra}`);
    }
    await mkdir(resolve(out), { recursive: true });
    await mkdir(resolve(outRestated), { recursive: true });
    const ambiguous: Record<string, readonly string[]> = {};
    for (const entry of cases) {
      const authored = authorRoleSamples(
        { id: entry.id, text: entry.query },
        specs[entry.id]!.map(([role, spans, restate, group]) => ({
          role,
          spans,
          restate,
          ...(group === undefined ? {} : { group }),
        })),
      );
      await writeFile(
        join(resolve(out), `${entry.id}.json`),
        JSON.stringify(authored.primary, null, 2),
        "utf8",
      );
      await writeFile(
        join(resolve(outRestated), `${entry.id}.json`),
        JSON.stringify(authored.restated, null, 2),
        "utf8",
      );
      if (authored.ambiguousSpans.length > 0) ambiguous[entry.id] = authored.ambiguousSpans;
    }
    console.log(JSON.stringify({ written: cases.length, ambiguous }, null, 2));
    return;
  }

  if (command === "replay") {
    const nativeManifest = values["native-manifest"];
    const { usage, store, model, roles, annotator, disclosure } = values;
    if (
      (usage !== "development" && usage !== "pilot") ||
      store === undefined ||
      model === undefined ||
      nativeManifest === undefined ||
      roles === undefined ||
      annotator === undefined ||
      disclosure === undefined
    ) {
      throw new Error(USAGE);
    }
    const development = usage === "development";
    const sha256 =
      values["queries-sha256"] ?? (development ? FROZEN_CONTROL_INPUTS.queriesSha256 : undefined);
    const revision =
      values["queries-revision"] ?? (development ? FROZEN_CONTROL_INPUTS.suiteRevision : undefined);
    const caseCount = Number(
      values["case-count"] ?? (development ? FROZEN_CONTROL_INPUTS.caseCount : Number.NaN),
    );
    if (sha256 === undefined || revision === undefined || !Number.isInteger(caseCount)) {
      throw new Error(USAGE);
    }
    const threads = FROZEN_CONTROL_INPUTS.threads;
    const config: RoleReplayConfig = {
      repoRoot: REPO_ROOT,
      outputDir: resolve(out),
      queriesPath: resolve(queries),
      queries: { revision, caseCount, sha256, usage },
      storeRoot: resolve(store),
      modelPath: resolve(model),
      nativeManifestPath: resolve(nativeManifest),
      threads,
      codeFiles: [...CODE_UNDER_TEST, ...(await toolSources())],
      pins: FROZEN_CONTROL_INPUTS,
      roleSets: {
        primary: resolve(roles),
        ...(values["roles-restated"] === undefined
          ? {}
          : { restated: resolve(values["roles-restated"]) }),
      },
      provenance: {
        independentOfTargets: values["roles-independent"] ?? false,
        annotator,
        disclosure,
      },
      resultLimit: FROZEN_SCORER.resultLimit,
      reportedRanks: FROZEN_SCORER.reportedRanks,
    };
    const manifest = await runRoleReplay(config, replayDeps(config.modelPath, threads));
    // Machine-specific paths stay beside the run, never inside the manifest.
    await writeFile(
      join(config.outputDir, "local-environment.json"),
      JSON.stringify(
        {
          queriesPath: config.queriesPath,
          storeRoot: config.storeRoot,
          modelPath: config.modelPath,
          nativeManifestPath: config.nativeManifestPath,
          roleSets: config.roleSets,
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(
      JSON.stringify(
        {
          status: manifest.status,
          controlComparison: manifest.controlComparison,
          conditions: manifest.conditions.map((c) => ({
            id: c.id,
            fallbackQueries: c.fallbackQueries,
            maxTextsPerQuery: c.maxTextsPerQuery,
          })),
          cost: manifest.cost,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (command === "score") {
    const devLabels = values["dev-labels"];
    const pilotLabels = values["pilot-labels"];
    if (devLabels === undefined && pilotLabels === undefined) throw new Error(USAGE);
    const report = await scoreRoleRun(resolve(out), {
      readQueries: async () => readFile(resolve(queries)),
      pilotLabelsIndependent: values["labels-independent"] ?? false,
      ...(devLabels === undefined
        ? {}
        : { readDevelopmentLabels: async () => readFile(resolve(devLabels)) }),
      ...(pilotLabels === undefined
        ? {}
        : {
            readPilotLabel: async (queryId: string) =>
              JSON.parse(
                await readFile(join(resolve(pilotLabels), `${queryId}.json`), "utf8"),
              ) as unknown,
          }),
    });
    console.log(JSON.stringify(report, null, 2));
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
