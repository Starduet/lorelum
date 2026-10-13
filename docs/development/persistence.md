# Engine persistence and Drizzle

Use this guide when changing SQLite persistence in `@lorelum/engine`. It explains where schema lives, how migrations are generated and applied, and where SQLite-specific SQL belongs.

This is an internal development guide. It does not change Pack format, CLI, or Backend contracts.

[Practice read](../../openspec/specs/practice-read/spec.md) owns canonical LocalStore recovery behavior, and [semantic index](../../openspec/specs/semantic-index/spec.md) owns derived-index safety. This guide records the implementation and maintenance rules used to uphold those contracts.

## Persistence model

Engine has Store-local and user-cache SQLite database kinds. They use one shared persistence foundation, but remain separate files because their lifecycles differ.

| Database | Purpose | Schema definition | Migration directory |
| --- | --- | --- | --- |
| LocalStore | installed Pack catalog, effective Practices, sources, and revision records | `packages/engine/src/persistence/schemas/local-store.ts` | `packages/engine/src/persistence/migrations/local-store/` |
| Store keyword index | Store-only FTS5 documents and the index checkpoint | `packages/engine/src/persistence/schemas/keyword-index.ts` | `packages/engine/src/persistence/migrations/keyword-index/` |
| Store semantic index | Legacy Store-local Profile metadata and Practice content-view vectors | `packages/engine/src/persistence/schemas/semantic-index.ts` | `packages/engine/src/persistence/migrations/semantic-index/` |
| Content-addressed cache catalog | Artifact inventory without source paths or Practice content | `packages/engine/src/persistence/schemas/project-cache.ts` | `packages/engine/src/persistence/migrations/project-cache/` |
| Shared vector cache | Reusable Profile/projection vectors | `packages/engine/src/persistence/schemas/semantic-vector-cache.ts` | `packages/engine/src/persistence/migrations/semantic-vector-cache/` |
| Project keyword artifact | Content-addressed ProjectContext FTS5 artifact | `packages/engine/src/persistence/schemas/keyword-index.ts` | `packages/engine/src/persistence/migrations/project-keyword-index/` |
| Content-addressed semantic artifact | Complete vector artifact for one Store or ProjectContext target | `packages/engine/src/persistence/schemas/semantic-index.ts` | `packages/engine/src/persistence/migrations/project-semantic-index/` |
| Semantic progress artifact | Mutable, queryable progress for one Store or ProjectContext target | `packages/engine/src/persistence/schemas/semantic-index.ts` | `packages/engine/src/persistence/migrations/semantic-progress-index/` |

The shared pieces are deliberately centralized:

- `packages/engine/src/persistence/definitions.ts` binds each schema to its migration directory.
- `packages/engine/src/persistence/database/connection.ts` creates the Bun SQLite and Drizzle connection pair.
- `packages/engine/src/persistence/database/migrator.ts` is the single wrapper around Drizzle runtime migration.

Do not create a package-local migration runner, a second connection factory, or a generic database selected by arbitrary strings. Domain modules own their own repository or index adapter; the shared layer owns the common SQLite/Drizzle mechanics.

## Drizzle is the default

For new relational persistence code, start with Drizzle. Use its schema and query APIs for ordinary CRUD, joins, aggregates, counts, and batch writes. A long or complicated query is not, by itself, a reason to switch to handwritten SQL.

Native SQL needs a specific SQLite-only reason that Drizzle cannot model adequately. Every new raw SQL call must stay in its owning persistence or index adapter, bind values rather than interpolate them into SQL text, explain that reason in a nearby comment, and have SQLite integration coverage.

Lifecycle services, CLI commands, and Backend controllers do not issue SQL directly. They call an Engine repository or index adapter.

## What belongs in a Drizzle schema

Use `sqliteTable()` for ordinary relational tables, columns, foreign keys, checks, and indexes. Keep the TypeScript table definition next to the database kind that owns the data.

Use native parameterized SQL when SQLite has a feature that is not a normal table mapping:

- FTS5 virtual-table DDL, `MATCH`, and `bm25` belong in the keyword-index implementation.
- `PRAGMA` calls and integrity checks stay with the SQLite adapter that needs them.
- vector BLOB encoding and validation stay in the semantic-index codec; ordinary vector-row reads and writes still use the semantic-index Drizzle schema.

Drizzle remains responsible for schema, migration history, ordinary metadata rows, and transactional CRUD around these operations. Native SQL is a narrow escape hatch inside the owning Engine module, not a reason for lifecycle code, CLI code, or Backend controllers to open SQLite directly.

## Changing a schema

For a normal table change:

1. Update the matching file under `packages/engine/src/persistence/schemas/`.
2. Run the repository's only public generator command:

   ```sh
   bun run db:generate
   ```

   It runs every checked-in LocalStore, Store-index, ProjectContext artifact, catalog, and shared-vector Drizzle configuration in a fixed order. Developers do not invoke separate generation scripts.

3. Review the generated SQL and Drizzle `meta/` files. The migration must describe the intended SQLite change; generation is not a substitute for review.
4. Add or update the owning repository/index tests and the behavior-level tests that exercise the changed data.
5. Commit the schema TypeScript, migration SQL, and generated metadata together.

Do not use `drizzle-kit push` against a developer Store, make schema changes with ad-hoc runtime DDL, or edit migration history as part of an ordinary feature change. Runtime behavior must come from checked-in migrations.

### Native SQL migrations

An FTS5 virtual-table shape change is still a schema change. Give it a reviewed custom SQL migration in the keyword-index migration directory, and keep the related search SQL and integration tests in `packages/engine/src/query/keyword/`.

The existing migration files are immutable records of what a database has applied. Drizzle does not rewrite them when `db:generate` runs. The repository currently exposes only the normal generator path; if a SQL-only migration is needed, extend `scripts/db/generate.ts` in the same change so it remains part of `bun run db:generate` rather than adding a second public database command. Do not append runtime DDL to a query path.

## When migrations run

`bun run db:generate` only creates files for review and commit. It does not touch a Store.

At runtime, the matching database adapter calls Drizzle's `migrate()` before it writes or uses a database that requires initialization. Drizzle records applied migration hashes in that SQLite file's `__drizzle_migrations` table and applies only missing checked-in migrations.

- Opening LocalStore uses `openStoreDatabase()` and applies LocalStore migrations before creating the LocalStore repository.
- Opening or building the persistent Store-only keyword index applies keyword-index migrations to the active or staging index file. ProjectContext keyword artifacts apply their independent project-keyword-index migrations.
- Building a Store-only semantic index applies semantic-index migrations to its staging SQLite file before metadata and vectors are inserted. ProjectContext complete and progress artifacts use their independent migration histories; complete artifacts are published atomically.
- Opening the content-addressed cache catalog or shared vector cache applies its own migrations before it records metadata or reusable vectors.

Store-only keyword and legacy semantic indexes remain Store-local derived state. ProjectContext keyword artifacts plus content-addressed semantic artifacts, progress, catalog, and shared vectors are user-level derived state under the selected cache root. Every index format remains versioned independently from the LocalStore schema, so publication and snapshot-validation rules must not be coupled to a LocalStore transaction.

## Transaction and ownership rules

- One SQLite transaction covers one physical database file. Do not claim a cross-file transaction exists.
- LocalStore repository writes keep the catalog, effective Practice rows, revision records, and outbox state consistent within LocalStore.
- Keyword FTS mutations and checkpoint updates share the owning Store-only or ProjectContext keyword-index transaction.
- Semantic content-view rows and semantic metadata share the owning Store-only, complete-artifact, or progress transaction; complete publication remains a separate close-and-rename step guarded by the current snapshot fence.
- Canonical query results are assembled from LocalStore or current ProjectContext sources. A keyword or semantic index supplies candidates and may be rebuilt, but does not become an alternate source for Practice content.

## Verification checklist

Before sending a persistence change for review:

```sh
bun run db:generate
bun test packages/engine/src/persistence
bun test packages/engine/src/local-store
bun run typecheck
```

Run the focused keyword or semantic tests when their database kind changes. For a real CLI check, use worktree-local `--store-root` and `--cache-root`; opening a Store or building an artifact can create derived files. Follow the [development workflow](./README.md#normal-development-workflow) for source, native-runtime, and release-staging validation.

For every migration, verify all of the following:

- generated SQL and `meta/` files match the schema diff;
- a fresh database receives the expected tables and `__drizzle_migrations` history;
- reopening the same database is idempotent;
- the owning use case still preserves its transaction, snapshot, and error semantics;
- FTS5, vector, and `PRAGMA` behavior remains covered by SQLite integration tests rather than TypeScript types alone.
- every new native SQL call states its SQLite-specific reason and binds its parameters safely.
