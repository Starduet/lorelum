import { z } from "zod";

import { sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";

/**
 * Relevance protocol for the new pilot queries, versioned separately from the
 * frozen v2 labels. v2 `coreIds` mean "every listed Practice must be found";
 * a sufficient alternative appended there would make that rule stricter, so
 * alternatives, supplements and uncertainty live only in this format.
 *
 * Version 2 (2026-10-08, before any G1 score existed) separates two success
 * notions that version 1 conflated. `fullyServed`: the top K holds a
 * sufficient alternative, or every required-core Practice of the query.
 * `anyHelp`: the top K holds at least one acceptable Practice, which may
 * serve only part of the task. The primary G1 success is `fullyServed` with no
 * forbidden Practice; `anyHelp` is reported next to it and never replaces it.
 */
export const PILOT_PROTOCOL_VERSION = 2;

export const PILOT_LABEL_CLASSES = [
  /** The task is not served without it. */
  "required-core",
  /** Serves the task on its own; a different Practice may also be required-core. */
  "sufficient-alternative",
  /** Helps, but is a prerequisite or supplement and does not serve the task alone. */
  "prerequisite-or-supplement",
  "irrelevant",
  /** Applying it to this task would mislead. */
  "forbidden",
  /** Nobody could judge reliably; kept as such, never counted as irrelevant. */
  "undetermined",
] as const;
export type PilotLabelClass = (typeof PILOT_LABEL_CLASSES)[number];

const classSchema = z.enum(PILOT_LABEL_CLASSES);
const sha = z.string().regex(/^[a-f0-9]{64}$/);

const itemSchema = z.strictObject({
  practiceId: z.string().min(1),
  /** Digest of the canonical content the reviewer read. */
  contentDigest: sha,
  class: classSchema,
  rationale: z.string().min(1),
  /** Present only for a review split: the competing classes, with the item left undetermined. */
  disagreement: z
    .strictObject({
      classes: z.array(classSchema).min(2),
      note: z.string().min(1),
    })
    .optional(),
});

const reviewSchema = z.strictObject({
  reviewers: z.number().int().min(1),
  /** The reviewer did not see which system or condition produced a Practice. */
  blindToSystem: z.boolean(),
  /** The reviewer did not see the rank order any condition produced. */
  blindToRanking: z.boolean(),
  /** Required whenever the review is single-reviewer or not blind: the dependence risk, stated plainly. */
  disclosure: z.string().optional(),
});

const labelSchema = z.strictObject({
  protocolVersion: z.literal(PILOT_PROTOCOL_VERSION),
  queryId: z.string().min(1),
  queryDigest: sha,
  review: reviewSchema,
  /** Explicit statement that the corpus holds no relevant target; an empty item list never implies it. */
  noRelevantTarget: z.boolean(),
  items: z.array(itemSchema),
});

export type PilotLabel = z.infer<typeof labelSchema>;

export type PilotLabelIssueCode =
  | "shape"
  | "query_id_mismatch"
  | "query_digest_mismatch"
  | "duplicate_practice"
  | "unknown_practice"
  | "content_digest_mismatch"
  | "target_declaration"
  | "disagreement_class"
  | "disagreement_needs_reviewers"
  | "disclosure_required";

export interface PilotLabelIssue {
  readonly code: PilotLabelIssueCode;
  readonly path: string;
  readonly message: string;
}

export class PilotLabelError extends ExperimentError {
  readonly issues: readonly PilotLabelIssue[];

  constructor(issues: readonly PilotLabelIssue[]) {
    super(
      "protocol_invalid",
      `Pilot label is invalid: ${issues.map((issue) => `${issue.code}@${issue.path}`).join(", ")}`,
    );
    this.name = "PilotLabelError";
    this.issues = issues;
  }
}

const ACCEPTABLE: ReadonlySet<PilotLabelClass> = new Set([
  "required-core",
  "sufficient-alternative",
]);

/**
 * Validate one pilot label against its query and the frozen corpus. Practices
 * the label does not mention stay unlabelled; they are never negatives.
 */
export function parsePilotLabel(
  raw: unknown,
  query: { readonly id: string; readonly text: string },
  corpusDigests: ReadonlyMap<string, string>,
): PilotLabel {
  const parsed = labelSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PilotLabelError(
      parsed.error.issues.map((issue) => ({
        code: "shape" as const,
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  const label = parsed.data;
  const issues: PilotLabelIssue[] = [];
  if (label.queryId !== query.id) {
    issues.push({
      code: "query_id_mismatch",
      path: "queryId",
      message: "label is for another query",
    });
  }
  if (label.queryDigest !== sha256Hex(query.text)) {
    issues.push({
      code: "query_digest_mismatch",
      path: "queryDigest",
      message: "queryDigest is not the SHA-256 of the query text",
    });
  }
  const { review } = label;
  if (
    (review.reviewers === 1 || !review.blindToSystem || !review.blindToRanking) &&
    !review.disclosure
  ) {
    issues.push({
      code: "disclosure_required",
      path: "review.disclosure",
      message: "a single-reviewer or non-blind review must disclose its dependence risk",
    });
  }
  const seen = new Set<string>();
  for (const [index, item] of label.items.entries()) {
    const path = `items[${index}]`;
    if (seen.has(item.practiceId)) {
      issues.push({ code: "duplicate_practice", path, message: "a Practice has one class only" });
    }
    seen.add(item.practiceId);
    const digest = corpusDigests.get(item.practiceId);
    if (digest === undefined) {
      issues.push({
        code: "unknown_practice",
        path,
        message: "Practice is not in the frozen corpus",
      });
    } else if (digest !== item.contentDigest) {
      issues.push({
        code: "content_digest_mismatch",
        path,
        message: "the reviewed content differs from the frozen corpus",
      });
    }
    if (item.disagreement !== undefined) {
      if (item.class !== "undetermined" || new Set(item.disagreement.classes).size < 2) {
        issues.push({
          code: "disagreement_class",
          path: `${path}.disagreement`,
          message:
            "a review split leaves the item undetermined and names at least two distinct classes",
        });
      }
      if (review.reviewers < 2) {
        issues.push({
          code: "disagreement_needs_reviewers",
          path: `${path}.disagreement`,
          message: "a disagreement needs at least two reviewers",
        });
      }
    }
  }
  const hasAcceptable = label.items.some((item) => ACCEPTABLE.has(item.class));
  if (label.noRelevantTarget === hasAcceptable) {
    issues.push({
      code: "target_declaration",
      path: "noRelevantTarget",
      message: hasAcceptable
        ? "noRelevantTarget is true although an acceptable Practice is listed"
        : "no acceptable Practice is listed, so noRelevantTarget must be true explicitly",
    });
  }
  if (issues.length > 0) throw new PilotLabelError(issues);
  return label;
}

export interface TopKSummary {
  readonly k: number;
  readonly classCounts: Readonly<Record<PilotLabelClass | "unlabelled", number>>;
  /** At least one required-core or sufficient-alternative Practice is in the top K. */
  readonly anyHelp: boolean;
  /** A sufficient alternative, or all required-core Practices of the query, are in the top K. */
  readonly fullyServed: boolean;
  readonly hasForbidden: boolean;
  /** The primary G1 success: fully served and no forbidden Practice in the top K. */
  readonly success: boolean;
}

/**
 * What the top K of a full ranking contains under a pilot label. Unlabelled
 * Practices are counted apart so the label coverage of two conditions can be
 * compared before any improvement is claimed.
 */
export function summarizeTopK(
  label: PilotLabel,
  rankedIds: readonly string[],
  k: number,
): TopKSummary {
  const classOf = new Map(label.items.map((item) => [item.practiceId, item.class]));
  const classCounts: Record<PilotLabelClass | "unlabelled", number> = {
    "required-core": 0,
    "sufficient-alternative": 0,
    "prerequisite-or-supplement": 0,
    irrelevant: 0,
    forbidden: 0,
    undetermined: 0,
    unlabelled: 0,
  };
  for (const id of rankedIds.slice(0, k)) classCounts[classOf.get(id) ?? "unlabelled"] += 1;
  const requiredTotal = label.items.filter((item) => item.class === "required-core").length;
  const anyHelp = classCounts["required-core"] + classCounts["sufficient-alternative"] > 0;
  const fullyServed =
    classCounts["sufficient-alternative"] > 0 ||
    (requiredTotal > 0 && classCounts["required-core"] === requiredTotal);
  const hasForbidden = classCounts.forbidden > 0;
  return {
    k,
    classCounts,
    anyHelp,
    fullyServed,
    hasForbidden,
    success: fullyServed && !hasForbidden,
  };
}
