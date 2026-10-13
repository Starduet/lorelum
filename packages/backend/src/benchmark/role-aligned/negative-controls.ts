import { type PlannedRole, type RoleQueryPlan } from "./candidate-policy";
import { ExperimentError } from "./experiment-error";
import { QUERY_ROLES, type RoleSample } from "./role-sample";

/**
 * Deterministic negative controls, registered before any role-condition
 * result. They isolate extra text and processing budget from role semantics.
 * Nothing here is random, so nothing needs a seed.
 *
 *   background   the control query with one fixed, meaning-neutral sentence
 *                appended. Same production clause path as control.
 *   segments     non-role text under the Q processing budget: the query cut
 *                into as many contiguous pieces as Q has texts, scored with
 *                Q's role slots and weights but with no role information.
 *   flat weights is `RoleWeighting` "flat" in role-conditions.ts.
 *   restated     a second manual sample set with equivalent wording and no
 *                new fact; it is data, not generated here.
 */
export const BACKGROUND_SENTENCE = Object.freeze({
  en: "This is part of an ongoing software project that several people work on.",
  zh: "这是多人共同参与的一个持续进行的软件项目的一部分。",
});

const CJK = /[\u3400-\u9fff]/u;

export function appendBackground(query: string): string {
  const sentence = CJK.test(query) ? BACKGROUND_SENTENCE.zh : BACKGROUND_SENTENCE.en;
  return `${query} ${sentence}`;
}

/**
 * Cut `query` into exactly `count` non-empty contiguous pieces of near-equal
 * length. A boundary moves to the closest whitespace inside half a piece so
 * Latin words stay whole; text without whitespace is cut at the raw boundary.
 * Surrogate pairs are never split.
 */
export function segmentQuery(query: string, count: number): readonly string[] {
  if (!Number.isInteger(count) || count < 1) {
    throw new ExperimentError("protocol_invalid", "A segment count must be a positive integer");
  }
  const length = query.length;
  if (count === 1) return [query.trim()];
  const window = Math.floor(length / count / 2);
  const boundaries: number[] = [0];
  for (let piece = 1; piece < count; piece += 1) {
    const target = Math.round((piece * length) / count);
    let boundary = target;
    for (let distance = 0; distance <= window; distance += 1) {
      if (/\s/u.test(query[target + distance] ?? "")) {
        boundary = target + distance;
        break;
      }
      if (distance > 0 && /\s/u.test(query[target - distance] ?? "")) {
        boundary = target - distance;
        break;
      }
    }
    const code = query.charCodeAt(boundary);
    if (code >= 0xdc00 && code <= 0xdfff && boundary > 0) boundary -= 1;
    boundaries.push(Math.max(boundary, boundaries[boundaries.length - 1]!));
  }
  boundaries.push(length);
  const pieces = boundaries
    .slice(0, -1)
    .map((start, index) => query.slice(start, boundaries[index + 1]).trim());
  if (pieces.some((piece) => piece.length === 0)) {
    throw new ExperimentError(
      "protocol_invalid",
      `The query is too short to be cut into ${count} non-empty pieces`,
    );
  }
  return pieces;
}

/**
 * The Q plan's role slots and weights, filled with query pieces instead of
 * role texts. Slots are filled in the order the roles first appear in the
 * query, so the assignment carries no role knowledge. A query with a fallback
 * plan has no slots and keeps the fallback.
 */
export function buildSegmentPlan(
  sample: RoleSample,
  plan: RoleQueryPlan,
  query: string,
): RoleQueryPlan {
  if (plan.status !== "roles") return plan;
  const firstStart = (role: PlannedRole["role"]): number =>
    Math.min(
      ...sample.roles
        .filter((annotation) => annotation.role === role)
        .map((annotation) => annotation.spans[0]!.start),
    );
  const slotOrder = [...plan.roles].sort(
    (left, right) =>
      firstStart(left.role) - firstStart(right.role) ||
      QUERY_ROLES.indexOf(left.role) - QUERY_ROLES.indexOf(right.role),
  );
  const slotCount = slotOrder.reduce((sum, planned) => sum + planned.texts.length, 0);
  const pieces = segmentQuery(query, slotCount);
  let next = 0;
  const filled = new Map<PlannedRole["role"], readonly string[]>();
  for (const planned of slotOrder) {
    filled.set(planned.role, pieces.slice(next, next + planned.texts.length));
    next += planned.texts.length;
  }
  return Object.freeze({
    status: "roles",
    roles: Object.freeze(
      plan.roles.map((planned) =>
        Object.freeze({
          role: planned.role,
          weight: planned.weight,
          texts: filled.get(planned.role)!,
        }),
      ),
    ),
  });
}
