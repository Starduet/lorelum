import { eq, inArray } from "drizzle-orm";

import type { SqliteConnection } from "../../../persistence/database/connection";
import { migrateSqlite } from "../../../persistence/database/migrator";
import {
  semanticIndexDatabaseDefinition,
  type SqliteDatabaseDefinition,
} from "../../../persistence/definitions";
import {
  semanticIndexMetadata,
  semanticVectors,
} from "../../../persistence/schemas/semantic-index";
import { SemanticIndexError } from "../errors";
import type { SemanticDocument, SemanticViewKind } from "../projection";
import type { SemanticIndexMetadata } from "./metadata";

export type SemanticIndexConnection = SqliteConnection<
  typeof semanticIndexDatabaseDefinition.schema
>;
export type SemanticIndexDatabaseDefinition = SqliteDatabaseDefinition<
  typeof semanticIndexDatabaseDefinition.schema
>;

interface MetadataRow extends Record<string, unknown> {
  readonly indexVersion: number;
  readonly rootBinding: string;
  readonly generation: number;
  readonly effectiveRevision: number;
  readonly manifestDigest: string;
  readonly profileId: string;
  readonly encodingId: string;
  readonly dimensions: number;
  readonly documentProjectionVersion: number;
  readonly normalization: string;
  readonly vectorCount: number;
}

interface VectorRow {
  readonly practiceId: string;
  readonly viewId: string;
  readonly viewKind: string;
  readonly viewOrdinal: number;
  readonly contentDigest: string;
  readonly projectionDigest: string;
  readonly vector: Uint8Array;
}

export interface SemanticIndexVector {
  readonly viewId: string;
  readonly viewKind: SemanticViewKind;
  readonly viewOrdinal: number;
  readonly contentDigest: string;
  readonly projectionDigest: string;
  readonly vector: Float32Array;
}

const DIGEST = /^[a-f0-9]{64}$/;

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function viewKind(value: unknown): SemanticViewKind {
  if (value === "full" || value === "task-card" || value === "body") return value;
  throw new SemanticIndexError("Semantic index view kind is invalid");
}

function metadataFromRow(row: unknown): SemanticIndexMetadata {
  if (typeof row !== "object" || row === null) {
    throw new SemanticIndexError("Semantic index metadata is missing");
  }
  const value = row as Partial<MetadataRow>;
  if (
    !positiveInteger(value.indexVersion) ||
    typeof value.rootBinding !== "string" ||
    !positiveInteger(value.generation) ||
    !positiveInteger(value.effectiveRevision) ||
    typeof value.manifestDigest !== "string" ||
    !DIGEST.test(value.profileId ?? "") ||
    !DIGEST.test(value.encodingId ?? "") ||
    !positiveInteger(value.dimensions) ||
    value.dimensions === 0 ||
    !positiveInteger(value.documentProjectionVersion) ||
    value.documentProjectionVersion === 0 ||
    value.normalization !== "l2" ||
    !positiveInteger(value.vectorCount)
  ) {
    throw new SemanticIndexError("Semantic index metadata is invalid");
  }
  return Object.freeze({
    indexVersion: value.indexVersion,
    rootBinding: value.rootBinding,
    generation: value.generation,
    effectiveRevision: value.effectiveRevision,
    manifestDigest: value.manifestDigest,
    profileId: value.profileId!,
    encodingId: value.encodingId!,
    dimensions: value.dimensions,
    documentProjectionVersion: value.documentProjectionVersion,
    normalization: value.normalization,
    vectorCount: value.vectorCount,
  });
}

function vectorBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function validateVectorBlob(value: unknown, dimensions: number): void {
  if (
    !(value instanceof Uint8Array) ||
    value.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT
  ) {
    throw new SemanticIndexError("Semantic index vector blob is invalid");
  }
  const copy = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  const vector = new Float32Array(copy);
  let squaredLength = 0;
  for (const item of vector) {
    if (!Number.isFinite(item)) throw new SemanticIndexError("Semantic index vector is not finite");
    squaredLength += item * item;
  }
  if (Math.abs(Math.sqrt(squaredLength) - 1) >= 0.001) {
    throw new SemanticIndexError("Semantic index vector is not L2-normalized");
  }
}

function vectorFromBlob(value: unknown, dimensions: number): Float32Array {
  validateVectorBlob(value, dimensions);
  const bytes = value as Uint8Array;
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Float32Array(copy);
}

const VIEW_ID = /^(full|task-card|body):(\d{4,})$/;

function validateViewIdentity(row: VectorRow): void {
  if (
    row.practiceId.length === 0 ||
    !positiveInteger(row.viewOrdinal) ||
    !DIGEST.test(row.contentDigest) ||
    !DIGEST.test(row.projectionDigest)
  ) {
    throw new SemanticIndexError("Semantic index vector identity is invalid");
  }
  const kind = viewKind(row.viewKind);
  const view = VIEW_ID.exec(row.viewId);
  if (view === null || view[1] !== kind || Number(view[2]!) !== row.viewOrdinal) {
    throw new SemanticIndexError("Semantic index view ID is invalid");
  }
}

function metadataRow(connection: SemanticIndexConnection): MetadataRow | undefined {
  return connection.orm
    .select({
      indexVersion: semanticIndexMetadata.indexVersion,
      rootBinding: semanticIndexMetadata.rootBinding,
      generation: semanticIndexMetadata.generation,
      effectiveRevision: semanticIndexMetadata.effectiveRevision,
      manifestDigest: semanticIndexMetadata.manifestDigest,
      profileId: semanticIndexMetadata.profileId,
      encodingId: semanticIndexMetadata.encodingId,
      dimensions: semanticIndexMetadata.dimensions,
      documentProjectionVersion: semanticIndexMetadata.documentProjectionVersion,
      normalization: semanticIndexMetadata.normalization,
      vectorCount: semanticIndexMetadata.vectorCount,
    })
    .from(semanticIndexMetadata)
    .where(eq(semanticIndexMetadata.singleton, 1))
    .get();
}

function insertMetadata(
  connection: SemanticIndexConnection,
  metadata: SemanticIndexMetadata,
): void {
  connection.orm
    .insert(semanticIndexMetadata)
    .values({ singleton: 1, ...metadata })
    .run();
}

function updateMetadata(
  connection: SemanticIndexConnection,
  metadata: SemanticIndexMetadata,
): void {
  connection.orm
    .update(semanticIndexMetadata)
    .set(metadata)
    .where(eq(semanticIndexMetadata.singleton, 1))
    .run();
  if (metadataRow(connection) === undefined) {
    throw new SemanticIndexError("Semantic index metadata is missing");
  }
}

function finalMetadata(
  metadata: SemanticIndexMetadata,
  nextPracticeCount: number,
): SemanticIndexMetadata {
  if (!Number.isSafeInteger(nextPracticeCount) || nextPracticeCount < 0) {
    throw new SemanticIndexError("Semantic index Practice count is invalid");
  }
  return Object.freeze({
    ...metadata,
    vectorCount: nextPracticeCount,
  });
}

function countVectors(connection: SemanticIndexConnection): number {
  return connection.orm
    .select({ practiceId: semanticVectors.practiceId })
    .from(semanticVectors)
    .all().length;
}

function countPractices(connection: SemanticIndexConnection): number {
  const rows = connection.orm
    .select({ practiceId: semanticVectors.practiceId })
    .from(semanticVectors)
    .all();
  const ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.practiceId !== "string" || row.practiceId.length === 0) {
      throw new SemanticIndexError("Semantic index Practice ID is invalid");
    }
    ids.add(row.practiceId);
  }
  return ids.size;
}

function vectorRows(
  documents: readonly SemanticDocument[],
  vectors: readonly (readonly Float32Array[])[],
  dimensions: number,
) {
  const rows: {
    readonly practiceId: string;
    readonly viewId: string;
    readonly viewKind: SemanticViewKind;
    readonly viewOrdinal: number;
    readonly contentDigest: string;
    readonly projectionDigest: string;
    readonly vector: Buffer;
  }[] = [];
  for (const [documentIndex, document] of documents.entries()) {
    const documentVectors = vectors[documentIndex];
    if (documentVectors === undefined || documentVectors.length !== document.views.length) {
      throw new SemanticIndexError("Semantic index view vector counts differ");
    }
    for (const [viewIndex, view] of document.views.entries()) {
      const blob = vectorBlob(documentVectors[viewIndex]!);
      validateVectorBlob(blob, dimensions);
      rows.push({
        practiceId: document.practiceId,
        viewId: view.viewId,
        viewKind: view.viewKind,
        viewOrdinal: view.ordinal,
        contentDigest: document.contentDigest,
        projectionDigest: view.projectionDigest,
        vector: blob,
      });
    }
  }
  return rows;
}

function validateDocumentVectorShape(
  documents: readonly SemanticDocument[],
  vectors: readonly (readonly Float32Array[])[],
): void {
  if (documents.length !== vectors.length) {
    throw new SemanticIndexError("Semantic index document and vector counts differ");
  }
  const practiceIds = new Set<string>();
  const viewIds = new Set<string>();
  for (const [documentIndex, document] of documents.entries()) {
    if (practiceIds.has(document.practiceId)) {
      throw new SemanticIndexError("Semantic index contains a duplicate Practice");
    }
    practiceIds.add(document.practiceId);
    const documentVectors = vectors[documentIndex];
    if (documentVectors === undefined || documentVectors.length !== document.views.length) {
      throw new SemanticIndexError("Semantic index view vector counts differ");
    }
    for (const view of document.views) {
      const key = `${document.practiceId}\0${view.viewId}`;
      if (viewIds.has(key))
        throw new SemanticIndexError("Semantic index contains a duplicate view");
      viewIds.add(key);
      validateViewIdentity({
        practiceId: document.practiceId,
        viewId: view.viewId,
        viewKind: view.viewKind,
        viewOrdinal: view.ordinal,
        contentDigest: document.contentDigest,
        projectionDigest: view.projectionDigest,
        vector: new Uint8Array(),
      });
    }
  }
}

export function initializeSemanticIndex(
  connection: SemanticIndexConnection,
  metadata: SemanticIndexMetadata,
  documents: readonly SemanticDocument[],
  vectors: readonly (readonly Float32Array[])[],
  definition: SemanticIndexDatabaseDefinition = semanticIndexDatabaseDefinition,
): void {
  validateDocumentVectorShape(documents, vectors);
  if (metadata.vectorCount !== documents.length) {
    throw new SemanticIndexError("Semantic index Practice count differs from its documents");
  }
  try {
    migrateSqlite(connection, definition);
    const rows = vectorRows(documents, vectors, metadata.dimensions);
    connection.orm.transaction(() => {
      insertMetadata(connection, metadata);
      if (rows.length > 0) connection.orm.insert(semanticVectors).values(rows).run();
    });
  } catch (error) {
    if (error instanceof SemanticIndexError) throw error;
    throw new SemanticIndexError("Cannot initialize semantic SQLite index", { cause: error });
  }
}

function rowsFor(connection: SemanticIndexConnection, practiceId?: string): readonly VectorRow[] {
  const query = connection.orm
    .select({
      practiceId: semanticVectors.practiceId,
      viewId: semanticVectors.viewId,
      viewKind: semanticVectors.viewKind,
      viewOrdinal: semanticVectors.viewOrdinal,
      contentDigest: semanticVectors.contentDigest,
      projectionDigest: semanticVectors.projectionDigest,
      vector: semanticVectors.vector,
    })
    .from(semanticVectors);
  return Object.freeze(
    (practiceId === undefined
      ? query.all()
      : query.where(eq(semanticVectors.practiceId, practiceId)).all()) as VectorRow[],
  );
}

/** Read all validated content views for one Practice for incremental reuse. */
export function readSemanticIndexVectors(
  connection: SemanticIndexConnection,
  practiceId: string,
  dimensions: number,
): readonly SemanticIndexVector[] | undefined {
  try {
    const rows = rowsFor(connection, practiceId);
    if (rows.length === 0) return undefined;
    return Object.freeze(
      rows.map((row) => {
        validateViewIdentity(row);
        return Object.freeze({
          viewId: row.viewId,
          viewKind: viewKind(row.viewKind),
          viewOrdinal: row.viewOrdinal,
          contentDigest: row.contentDigest,
          projectionDigest: row.projectionDigest,
          vector: vectorFromBlob(row.vector, dimensions),
        });
      }),
    );
  } catch (error) {
    if (error instanceof SemanticIndexError) throw error;
    throw new SemanticIndexError("Cannot read semantic index vectors", { cause: error });
  }
}

/** Replace the final rows touched by a retained Store revision sequence. */
export function applySemanticIndexChanges(
  connection: SemanticIndexConnection,
  target: SemanticIndexMetadata,
  removedPracticeIds: readonly string[],
  documents: readonly SemanticDocument[],
  vectors: readonly (readonly Float32Array[])[],
): SemanticIndexMetadata {
  validateDocumentVectorShape(documents, vectors);
  const removed = [...new Set(removedPracticeIds)].sort();
  let written: SemanticIndexMetadata | undefined;
  try {
    const rows = vectorRows(documents, vectors, target.dimensions);
    connection.orm.transaction(() => {
      if (removed.length > 0) {
        connection.orm
          .delete(semanticVectors)
          .where(inArray(semanticVectors.practiceId, removed))
          .run();
      }
      if (rows.length > 0) connection.orm.insert(semanticVectors).values(rows).run();
      written = finalMetadata(target, countPractices(connection));
      updateMetadata(connection, written);
    });
    if (written === undefined)
      throw new SemanticIndexError("Semantic index metadata was not updated");
    return written;
  } catch (error) {
    if (error instanceof SemanticIndexError) throw error;
    throw new SemanticIndexError("Cannot update semantic SQLite index", { cause: error });
  }
}

export function readSemanticIndexMetadata(
  connection: SemanticIndexConnection,
): SemanticIndexMetadata {
  try {
    const metadata = metadataFromRow(metadataRow(connection));
    const rows = rowsFor(connection);
    for (const row of rows) {
      validateViewIdentity(row);
      validateVectorBlob(row.vector, metadata.dimensions);
    }
    const practices = countPractices(connection);
    if (practices !== metadata.vectorCount) {
      throw new SemanticIndexError("Semantic index Practice count is inconsistent");
    }
    if (rows.length < practices) {
      throw new SemanticIndexError("Semantic index contains a Practice without a vector view");
    }
    return metadata;
  } catch (error) {
    if (error instanceof SemanticIndexError) throw error;
    throw new SemanticIndexError("Cannot read semantic SQLite index metadata", { cause: error });
  }
}

export function verifySemanticIndexIntegrity(connection: SemanticIndexConnection): void {
  try {
    // SQLite integrity_check is a database-engine diagnostic, not relational CRUD.
    const rows = connection.client.query("PRAGMA integrity_check").all() as unknown[];
    if (
      rows.length !== 1 ||
      typeof rows[0] !== "object" ||
      rows[0] === null ||
      !("integrity_check" in rows[0]) ||
      rows[0].integrity_check !== "ok"
    ) {
      throw new SemanticIndexError("Semantic SQLite index integrity check failed");
    }
    countVectors(connection);
  } catch (error) {
    if (error instanceof SemanticIndexError) throw error;
    throw new SemanticIndexError("Cannot verify semantic SQLite index", { cause: error });
  }
}
