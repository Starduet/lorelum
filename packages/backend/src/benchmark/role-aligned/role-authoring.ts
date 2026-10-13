import { sha256Hex } from "./digest";
import { ExperimentError } from "./experiment-error";
import { parseRoleSample, ROLE_KINDS, type RoleKind, type RoleSample } from "./role-sample";

/**
 * Compact authoring form of a manual role sample. An annotator quotes the
 * query fragments that carry a role and, separately, one equivalent-wording
 * restatement; offsets are resolved here so a typo cannot silently point at
 * the wrong span. The annotator sees the query text only.
 */
export interface AuthoringEntry {
  readonly role: RoleKind;
  /** Verbatim query fragments, in query order. */
  readonly spans: readonly string[];
  /** The same facts in other words, for the restatement control. */
  readonly restate: string;
  readonly group?: string;
}

export interface AuthoredSamples {
  /** Verbatim role texts: the Q and Q+I input. */
  readonly primary: RoleSample;
  /** Restated role texts: the wording control. */
  readonly restated: RoleSample;
  /** Fragments that occur more than once in the query; the first occurrence was used. */
  readonly ambiguousSpans: readonly string[];
}

export const PRIMARY_ANALYSIS_VERSION = "manual/1";
export const RESTATED_ANALYSIS_VERSION = "manual/1-restated";

function resolveSpans(
  query: string,
  fragments: readonly string[],
  ambiguous: string[],
): { start: number; end: number }[] {
  let cursor = 0;
  return fragments.map((fragment) => {
    const start = query.indexOf(fragment, cursor);
    if (start < 0 || fragment.length === 0) {
      throw new ExperimentError(
        "protocol_invalid",
        `Fragment "${fragment}" is not in the query after offset ${cursor}`,
      );
    }
    if (query.indexOf(fragment, start + 1) >= 0) ambiguous.push(fragment);
    cursor = start + fragment.length;
    return { start, end: cursor };
  });
}

export function authorRoleSamples(
  query: { readonly id: string; readonly text: string },
  entries: readonly AuthoringEntry[],
): AuthoredSamples {
  const ambiguousSpans: string[] = [];
  const build = (analysisVersion: string, restated: boolean): RoleSample => {
    const roles = entries.map((entry) => {
      if (!ROLE_KINDS.includes(entry.role)) {
        throw new ExperimentError("protocol_invalid", `Unknown role ${entry.role}`);
      }
      const spans = resolveSpans(query.text, entry.spans, restated ? [] : ambiguousSpans);
      return {
        role: entry.role,
        ...(entry.group === undefined ? {} : { actionGroup: entry.group }),
        text: restated ? entry.restate : entry.spans.join(" "),
        spans,
        restated,
        inference: restated
          ? "Equivalent wording of the cited fragment; it adds no fact."
          : `The cited fragment is read as ${entry.role}.`,
      };
    });
    return parseRoleSample(
      {
        formatVersion: 1,
        spanUnit: "utf16-code-unit",
        queryId: query.id,
        queryDigest: sha256Hex(query.text),
        analysisVersion,
        analysisKind: "manual",
        roles,
      },
      query,
    ).sample;
  };
  return {
    primary: build(PRIMARY_ANALYSIS_VERSION, false),
    restated: build(RESTATED_ANALYSIS_VERSION, true),
    ambiguousSpans: [...new Set(ambiguousSpans)],
  };
}
