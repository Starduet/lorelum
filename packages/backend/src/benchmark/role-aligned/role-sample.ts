import { z } from "zod";

import { digestJson, sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";

/**
 * Registered source-backed query role sample. One file describes one query.
 * Roles may be missing, repeated, attached to several actions, or assigned to
 * the same source fragment more than once; nothing here requires all five.
 */
export const ROLE_SAMPLE_FORMAT_VERSION = 1;

/** Span offsets are JavaScript string indices into the query exactly as stored in the suite. */
export const SPAN_OFFSET_UNIT = "utf16-code-unit" as const;

export const QUERY_ROLES = ["intent", "moment", "artifact", "constraints", "domain"] as const;
export type QueryRole = (typeof QUERY_ROLES)[number];
/** `unknown` marks a source fragment the annotator could not assign; it is never scored. */
export const ROLE_KINDS = [...QUERY_ROLES, "unknown"] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

const spanSchema = z.strictObject({
  /** Inclusive start offset. */
  start: z.number().int().min(0),
  /** Exclusive end offset. */
  end: z.number().int().min(1),
});

const annotationSchema = z.strictObject({
  role: z.enum(ROLE_KINDS),
  /** Links a role to one action when a query carries several; an intent opens the group. */
  actionGroup: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]*$/)
    .optional(),
  /** The text that would be encoded for this role. */
  text: z.string().min(1),
  /** Source fragments supporting the role; ascending and non-overlapping. */
  spans: z.array(spanSchema).min(1),
  /** True when `text` differs from the joined source fragments. */
  restated: z.boolean(),
  /** Why this role was assigned, and for a restatement which source facts it uses. */
  inference: z.string().min(1),
});

const sampleSchema = z.strictObject({
  formatVersion: z.literal(ROLE_SAMPLE_FORMAT_VERSION),
  spanUnit: z.literal(SPAN_OFFSET_UNIT),
  queryId: z.string().min(1),
  /** SHA-256 of the UTF-8 query text. */
  queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** Identifies the annotator or analyzer and its version, for example `manual/1`. */
  analysisVersion: z.string().min(1),
  analysisKind: z.enum(["manual", "automatic"]),
  roles: z.array(annotationSchema),
});

export type RoleAnnotation = z.infer<typeof annotationSchema>;
export type RoleSample = z.infer<typeof sampleSchema>;

export type RoleSampleIssueCode =
  | "shape"
  | "query_id_mismatch"
  | "query_digest_mismatch"
  | "span_out_of_range"
  | "span_splits_surrogate_pair"
  | "span_order"
  | "text_mismatch"
  | "restatement_identical"
  | "unknown_cannot_restate"
  | "unknown_cannot_group"
  | "dangling_action_group"
  | "duplicate_role";

export interface RoleSampleIssue {
  readonly code: RoleSampleIssueCode;
  readonly path: string;
  readonly message: string;
}

export class RoleSampleError extends ExperimentError {
  readonly issues: readonly RoleSampleIssue[];

  constructor(issues: readonly RoleSampleIssue[]) {
    super(
      "protocol_invalid",
      `Role sample is invalid: ${issues.map((issue) => `${issue.code}@${issue.path}`).join(", ")}`,
    );
    this.name = "RoleSampleError";
    this.issues = issues;
  }
}

export interface ValidatedRoleSample {
  /** Roles in canonical order, so equal content has one digest whatever the input order. */
  readonly sample: RoleSample;
  readonly digest: string;
}

function isSplitSurrogate(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) return false;
  const before = text.charCodeAt(index - 1);
  const at = text.charCodeAt(index);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

function annotationOrder(left: RoleAnnotation, right: RoleAnnotation): number {
  const roleOrder = ROLE_KINDS.indexOf(left.role) - ROLE_KINDS.indexOf(right.role);
  if (roleOrder !== 0) return roleOrder;
  const leftGroup = left.actionGroup ?? "";
  const rightGroup = right.actionGroup ?? "";
  if (leftGroup !== rightGroup) return leftGroup < rightGroup ? -1 : 1;
  const startOrder = (left.spans[0]?.start ?? 0) - (right.spans[0]?.start ?? 0);
  if (startOrder !== 0) return startOrder;
  return left.text < right.text ? -1 : left.text > right.text ? 1 : 0;
}

function checkAnnotation(
  annotation: RoleAnnotation,
  path: string,
  queryText: string,
  issues: RoleSampleIssue[],
): void {
  let spansUsable = true;
  let previousEnd = 0;
  for (const [spanIndex, span] of annotation.spans.entries()) {
    const spanPath = `${path}.spans[${spanIndex}]`;
    if (span.end <= span.start || span.end > queryText.length) {
      issues.push({
        code: "span_out_of_range",
        path: spanPath,
        message: `span [${span.start}, ${span.end}) is empty or outside the ${queryText.length}-unit query`,
      });
      spansUsable = false;
      continue;
    }
    if (isSplitSurrogate(queryText, span.start) || isSplitSurrogate(queryText, span.end)) {
      issues.push({
        code: "span_splits_surrogate_pair",
        path: spanPath,
        message: "span boundary falls inside a surrogate pair",
      });
      spansUsable = false;
    }
    if (span.start < previousEnd) {
      issues.push({
        code: "span_order",
        path: spanPath,
        message: "spans must be ascending and must not overlap",
      });
      spansUsable = false;
    }
    previousEnd = span.end;
  }
  if (annotation.role === "unknown") {
    if (annotation.restated) {
      issues.push({
        code: "unknown_cannot_restate",
        path,
        message: "an unknown fragment is kept verbatim and cannot be restated",
      });
    }
    if (annotation.actionGroup !== undefined) {
      issues.push({
        code: "unknown_cannot_group",
        path,
        message: "an unknown fragment cannot be attached to an action",
      });
    }
  }
  if (!spansUsable) return;
  const joined = annotation.spans.map((span) => queryText.slice(span.start, span.end)).join(" ");
  if (!annotation.restated && annotation.text !== joined) {
    issues.push({
      code: "text_mismatch",
      path: `${path}.text`,
      message: "a non-restated role text must equal its source fragments joined by one space",
    });
  }
  if (annotation.restated && annotation.text === joined) {
    issues.push({
      code: "restatement_identical",
      path: `${path}.restated`,
      message: "restated is true but the text equals the source fragments",
    });
  }
}

/**
 * Parse and verify one role sample against the exact query it describes. The
 * check proves the structure and the source anchoring; it cannot prove that a
 * restatement adds no fact, so a restated role must cite its supporting source
 * spans and carry an inference note for reviewers.
 */
export function parseRoleSample(
  raw: unknown,
  query: { readonly id: string; readonly text: string },
): ValidatedRoleSample {
  const parsed = sampleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new RoleSampleError(
      parsed.error.issues.map((issue) => ({
        code: "shape" as const,
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  const sample = parsed.data;
  const issues: RoleSampleIssue[] = [];
  if (sample.queryId !== query.id) {
    issues.push({
      code: "query_id_mismatch",
      path: "queryId",
      message: `sample describes ${sample.queryId}, not ${query.id}`,
    });
  }
  if (sample.queryDigest !== sha256Hex(query.text)) {
    issues.push({
      code: "query_digest_mismatch",
      path: "queryDigest",
      message: "queryDigest is not the SHA-256 of the query text",
    });
  }
  const seen = new Set<string>();
  for (const [index, annotation] of sample.roles.entries()) {
    const path = `roles[${index}]`;
    checkAnnotation(annotation, path, query.text, issues);
    const key = JSON.stringify([annotation.role, annotation.actionGroup ?? null, annotation.text]);
    if (seen.has(key)) {
      issues.push({ code: "duplicate_role", path, message: "duplicate role, group and text" });
    }
    seen.add(key);
  }
  const intentGroups = new Set(
    sample.roles
      .filter((annotation) => annotation.role === "intent")
      .flatMap((annotation) =>
        annotation.actionGroup === undefined ? [] : [annotation.actionGroup],
      ),
  );
  for (const [index, annotation] of sample.roles.entries()) {
    if (
      annotation.role !== "intent" &&
      annotation.role !== "unknown" &&
      annotation.actionGroup !== undefined &&
      !intentGroups.has(annotation.actionGroup)
    ) {
      issues.push({
        code: "dangling_action_group",
        path: `roles[${index}].actionGroup`,
        message: `no intent opens action group ${annotation.actionGroup}`,
      });
    }
  }
  if (issues.length > 0) throw new RoleSampleError(issues);
  const canonical: RoleSample = { ...sample, roles: [...sample.roles].sort(annotationOrder) };
  return Object.freeze({ sample: canonical, digest: digestJson(canonical) });
}
