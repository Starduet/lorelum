import { createHash } from "node:crypto";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * JSON with lexicographically ordered object keys. Digests of structured
 * records must not depend on property insertion order.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function digestJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortKeys(record[key]);
    return sorted;
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("canonicalJson cannot represent a non-finite number");
  }
  return value;
}
