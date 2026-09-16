import { access, mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import { diffEffectivePractices } from "../../model";
import { rebuildEffectivePracticesFromManifest } from "../artifacts/rebuild";
import {
  clearOperationJournal,
  createOperationJournalRecord,
  writeOperationJournal,
} from "../journal/operation-journal";
import {
  tryReadManifest,
  writeManifest,
  type InstalledPacksManifest,
} from "../manifest/manifest-store";
import { acquireMutationLock } from "../mutation-lock";
import { SqliteStateError, StoreRecoveryRequiredError } from "../errors";

import { sqlitePath } from "./database";
import { migrateDatabase } from "./migrations";
import { createSqliteConnection } from "../../../persistence/database/connection";
import { localStoreDatabaseDefinition } from "../../../persistence/definitions";
import { readLocalStoreSnapshot } from "./snapshot-reader";
import { writeDerivedState } from "./state-writer";

const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";
const RENAME_RETRY_ATTEMPTS = 10;
const RENAME_RETRY_DELAY_MS = 50;

function isTransientRenameError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EACCES" || error.code === "EBUSY" || error.code === "EPERM";
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; attempt < RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop -- file-handle retries must remain sequential
      await rename(source, destination);
      return;
    } catch (error) {
      if (!isTransientRenameError(error) || attempt === RENAME_RETRY_ATTEMPTS - 1) throw error;
      // eslint-disable-next-line no-await-in-loop -- file-handle retries must remain sequential
      await new Promise<void>((resolve) => setTimeout(resolve, RENAME_RETRY_DELAY_MS));
    }
  }
}

function hasTable(database: Database, name: string): boolean {
  // SQLite's catalog is the only reliable way to distinguish a legacy file
  // from a Drizzle-managed LocalStore before attempting any migration.
  const row = database
    .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== null && row !== undefined;
}

async function hasStoreDatabase(rootPath: string): Promise<boolean> {
  try {
    await access(sqlitePath(rootPath));
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/** A manual LocalStore schema is legacy only when it has no Drizzle history. */
async function isLegacyStore(rootPath: string): Promise<boolean> {
  if (!(await hasStoreDatabase(rootPath))) return false;
  let database: Database | undefined;
  try {
    database = new Database(sqlitePath(rootPath), { readonly: true });
    if (hasTable(database, DRIZZLE_MIGRATIONS_TABLE)) return false;
    return hasTable(database, "local_store_metadata");
  } catch (error) {
    throw new SqliteStateError("cannot inspect existing LocalStore database", error);
  } finally {
    database?.close(true);
  }
}

async function discardLegacyDerivedState(rootPath: string): Promise<void> {
  await Promise.all([
    rm(join(rootPath, "operations"), { recursive: true, force: true }),
    rm(join(rootPath, "indexes", "keyword"), { recursive: true, force: true }),
    rm(join(rootPath, "indexes", "semantic"), { recursive: true, force: true }),
  ]);
}

/** A baseline reset is a reindex-style recovery event, so it gets a fresh tuple. */
function nextBaselineManifest(manifest: InstalledPacksManifest): InstalledPacksManifest {
  if (
    !Number.isSafeInteger(manifest.generation) ||
    !Number.isSafeInteger(manifest.effectiveRevision) ||
    manifest.generation === Number.MAX_SAFE_INTEGER ||
    manifest.effectiveRevision === Number.MAX_SAFE_INTEGER
  ) {
    throw new StoreRecoveryRequiredError("Legacy LocalStore counters cannot advance safely");
  }
  return Object.freeze({
    schemaVersion: manifest.schemaVersion,
    generation: manifest.generation + 1,
    effectiveRevision: manifest.effectiveRevision + 1,
    packs: manifest.packs,
  });
}

/** Replace an existing SQLite file without relying on rename-overwrite semantics. */
async function replaceDatabaseFile(path: string, stagingPath: string): Promise<void> {
  if (process.platform !== "win32") {
    await renameWithRetry(stagingPath, path);
    return;
  }

  // Windows cannot rename a file over an existing SQLite database. Quarantine
  // the old projection first, then restore it if publishing the replacement
  // fails so the recovery journal can still converge to the old tuple.
  const quarantine = `${path}.legacy-${crypto.randomUUID()}`;
  await renameWithRetry(path, quarantine);
  try {
    await renameWithRetry(stagingPath, path);
  } catch (error) {
    try {
      await renameWithRetry(quarantine, path);
    } catch {
      throw new StoreRecoveryRequiredError(
        "Legacy LocalStore cannot restore its SQLite projection after rebuild failure",
      );
    }
    throw error;
  }
  await rm(quarantine, { force: true }).catch(() => undefined);
}

async function publishRebuiltDatabase(rootPath: string, fullRefresh: boolean): Promise<void> {
  const path = sqlitePath(rootPath);
  const stagingPath = `${path}.next-${crypto.randomUUID()}`;
  let database: Database | undefined;
  try {
    const manifest = await tryReadManifest(rootPath);
    if (manifest === undefined) {
      throw new StoreRecoveryRequiredError(
        "Legacy LocalStore has no manifest from which to rebuild its SQLite projection",
      );
    }
    const effectivePractices = await rebuildEffectivePracticesFromManifest(rootPath, manifest);
    const targetManifest = fullRefresh ? nextBaselineManifest(manifest) : manifest;
    const fullRefreshDelta = diffEffectivePractices([], effectivePractices);

    database = new Database(stagingPath);
    migrateDatabase(database);
    const connection = createSqliteConnection(database, localStoreDatabaseDefinition.schema);
    writeDerivedState(connection.orm, {
      generation: targetManifest.generation,
      effectiveRevision: targetManifest.effectiveRevision,
      activePacks: targetManifest.packs,
      effectivePractices,
      ...(fullRefresh
        ? {
            revisionNotification: { delta: fullRefreshDelta, supersedesPending: true },
            clearRevisionLog: true,
          }
        : {}),
    });
    const snapshot = readLocalStoreSnapshot(connection.orm);
    if (
      snapshot === undefined ||
      snapshot.metadata.generation !== targetManifest.generation ||
      snapshot.metadata.effectiveRevision !== targetManifest.effectiveRevision
    ) {
      throw new StoreRecoveryRequiredError(
        "Legacy LocalStore rebuild did not produce a valid snapshot",
      );
    }
    database.close(true);
    database = undefined;

    await discardLegacyDerivedState(rootPath);
    const journal = fullRefresh
      ? createOperationJournalRecord("reindex", manifest, targetManifest)
      : undefined;
    if (journal !== undefined) {
      await writeOperationJournal(rootPath, journal);
      await writeManifest(rootPath, targetManifest);
    }
    await Promise.all([rm(`${path}-wal`, { force: true }), rm(`${path}-shm`, { force: true })]);
    await replaceDatabaseFile(path, stagingPath);
    if (journal !== undefined) await clearOperationJournal(rootPath, journal.operationId);
  } catch (error) {
    if (error instanceof StoreRecoveryRequiredError) throw error;
    throw new StoreRecoveryRequiredError(
      "Legacy LocalStore cannot be rebuilt from its manifest and Pack artifacts",
    );
  } finally {
    database?.close(true);
    await rm(stagingPath, { force: true }).catch(() => undefined);
  }
}

/** Reset a legacy manual SQLite projection while the Store mutation lock is already held. */
export async function resetLegacyStoreUnderLock(
  rootPath: string,
  options: { readonly fullRefresh?: boolean } = {},
): Promise<boolean> {
  if (!(await isLegacyStore(rootPath))) return false;
  await publishRebuiltDatabase(rootPath, options.fullRefresh !== false);
  return true;
}

/** Ensure ordinary readers reset a legacy Store before any journal recovery attempts. */
export async function ensureCurrentStoreBaseline(rootPath: string): Promise<boolean> {
  await mkdir(rootPath, { recursive: true });
  if (!(await isLegacyStore(rootPath))) return false;
  const lock = await acquireMutationLock(rootPath);
  try {
    return await resetLegacyStoreUnderLock(rootPath);
  } finally {
    await lock.release();
  }
}
