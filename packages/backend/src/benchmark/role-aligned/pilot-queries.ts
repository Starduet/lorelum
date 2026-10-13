import { z } from "zod";

import { sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";

/**
 * Intake format for the G1 pilot queries. It checks what can be checked before
 * freezing: where a task came from, that same-origin rewrites share a task
 * cluster, and which of the registered coverage categories are present. It
 * cannot prove a task is real; `source.description` is the collector's claim
 * and is kept for the reviewer.
 */
export const PILOT_CATEGORIES = [
  /** The current action and the technical background are easy to confuse. */
  "action-vs-background",
  /** A state or necessary condition decides applicability. */
  "state-or-condition",
  /** A thin or uncovered task. */
  "thin-or-uncovered",
  "multi-intent",
  /** The corpus is expected to hold no relevant target. */
  "no-target",
] as const;
export type PilotCategory = (typeof PILOT_CATEGORIES)[number];

/** Registered workload range; a floor and a ceiling for effort, not a statistical power claim. */
export const PILOT_SIZE = Object.freeze({ minimum: 24, maximum: 40 });

const caseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  query: z.string().min(1),
  /** Same-origin rewrites share one cluster and count as one independent task. */
  taskCluster: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  language: z.enum(["en", "zh", "other"]),
  categories: z.array(z.enum(PILOT_CATEGORIES)).min(1),
  source: z.strictObject({
    /**
     * `real-task`: a task someone actually had. `perturbation`: a synthetic edit of a real task;
     * allowed only as a negative control, never as a held-out task.
     */
    kind: z.enum(["real-task", "perturbation"]),
    description: z.string().min(1),
    /** Collected before the strategy was frozen and without looking at any target Practice. */
    collectedBlindToTargets: z.boolean(),
    /** For a perturbation, the `id` of the real task it edits. */
    derivedFrom: z.string().optional(),
  }),
});

const fileSchema = z.strictObject({
  formatVersion: z.literal(1),
  revision: z.string().min(1),
  usage: z.literal("pilot"),
  cases: z.array(caseSchema).min(1),
});

export type PilotQuerySet = z.infer<typeof fileSchema>;

export interface PilotIntakeReport {
  readonly revision: string;
  readonly caseCount: number;
  readonly clusterCount: number;
  readonly byCategory: Readonly<Record<PilotCategory, number>>;
  readonly byLanguage: Readonly<Record<string, number>>;
  /** Problems that stop freezing. */
  readonly errors: readonly string[];
  /** Conditions that keep the pilot from a clean verdict but do not prevent a run. */
  readonly warnings: readonly string[];
  /** The `queries.json` the replay reads: id and query only, in file order. */
  readonly queriesJson: {
    readonly revision: string;
    readonly cases: readonly { id: string; query: string }[];
  };
  /** SHA-256 of the exact `queriesJson` bytes; this is what `--queries-sha256` pins. */
  readonly queriesSha256: string;
}

export function serializeQueries(queries: PilotIntakeReport["queriesJson"]): string {
  return JSON.stringify(queries);
}

/** Validate an intake file. It throws only for a malformed file; content problems are reported. */
export function checkPilotIntake(raw: unknown): PilotIntakeReport {
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ExperimentError(
      "protocol_invalid",
      `Pilot intake is invalid: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const { cases, revision } = parsed.data;
  const errors: string[] = [];
  const warnings: string[] = [];

  const ids = new Set<string>();
  for (const entry of cases) {
    if (ids.has(entry.id)) errors.push(`duplicate id ${entry.id}`);
    ids.add(entry.id);
  }
  const held = cases.filter((entry) => entry.source.kind === "real-task");
  for (const entry of cases) {
    if (entry.source.kind === "perturbation") {
      errors.push(
        `${entry.id} is a perturbation; it may only be a negative control and cannot be a pilot task`,
      );
    }
    if (!entry.source.collectedBlindToTargets) {
      errors.push(`${entry.id} was not collected blind to the target Practices`);
    }
  }
  const texts = new Map<string, string>();
  for (const entry of held) {
    const key = entry.query.trim().toLowerCase().replace(/\s+/gu, " ");
    const other = texts.get(key);
    if (other !== undefined) errors.push(`${entry.id} repeats the text of ${other}`);
    texts.set(key, entry.id);
  }

  const clusters = new Set(held.map((entry) => entry.taskCluster));
  if (clusters.size < PILOT_SIZE.minimum) {
    warnings.push(
      `${clusters.size} independent task clusters is below the registered minimum ${PILOT_SIZE.minimum}`,
    );
  }
  if (held.length > PILOT_SIZE.maximum) {
    warnings.push(
      `${held.length} queries exceeds the registered range ${PILOT_SIZE.minimum}-${PILOT_SIZE.maximum}`,
    );
  }
  const byCategory = Object.fromEntries(
    PILOT_CATEGORIES.map((category) => [category, 0]),
  ) as Record<PilotCategory, number>;
  for (const entry of held)
    for (const category of new Set(entry.categories)) byCategory[category] += 1;
  for (const category of PILOT_CATEGORIES) {
    if (byCategory[category] === 0) warnings.push(`no pilot query covers ${category}`);
  }
  const byLanguage: Record<string, number> = {};
  for (const entry of held) byLanguage[entry.language] = (byLanguage[entry.language] ?? 0) + 1;
  if ((byLanguage.zh ?? 0) === 0)
    warnings.push("no Chinese query: language generalization is not tested");

  const queriesJson = {
    revision,
    cases: held.map((entry) => ({ id: entry.id, query: entry.query })),
  };
  return {
    revision,
    caseCount: held.length,
    clusterCount: clusters.size,
    byCategory,
    byLanguage,
    errors,
    warnings,
    queriesJson,
    queriesSha256: sha256Hex(serializeQueries(queriesJson)),
  };
}
