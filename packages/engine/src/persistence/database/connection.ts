import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export interface SqliteConnection<Schema extends Record<string, unknown>> {
  readonly client: Database;
  readonly orm: BunSQLiteDatabase<Schema>;
  close(): void;
}

export interface OpenSqliteConnectionOptions {
  readonly readonly?: boolean;
}

/** Wrap a caller-owned bun:sqlite client without changing its lifecycle. */
export function createSqliteConnection<Schema extends Record<string, unknown>>(
  client: Database,
  schema: Schema,
): SqliteConnection<Schema> {
  const orm = drizzle({ client, schema });
  return Object.freeze({
    client,
    orm,
    close() {
      client.close(true);
    },
  });
}

/** The only Engine persistence entrypoint that creates a bun:sqlite handle. */
export function openSqliteConnection<Schema extends Record<string, unknown>>(
  path: string,
  schema: Schema,
  options: OpenSqliteConnectionOptions = {},
): SqliteConnection<Schema> {
  let client: Database | undefined;
  try {
    const opened =
      options.readonly === true ? new Database(path, { readonly: true }) : new Database(path);
    client = opened;
    return createSqliteConnection(opened, schema);
  } catch (error) {
    client?.close(true);
    throw error;
  }
}
