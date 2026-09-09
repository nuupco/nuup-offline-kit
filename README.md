# @nuup/offline-kit

Offline-first toolkit for React Native/Expo apps: SQLite migrations, a pull-only sync engine, and a query/store abstraction. Written in TypeScript, compiled with plain `tsc` into a committed `dist/`.

> Status: not yet published to npm. Consumed by installing straight from GitHub (or a tarball via `npm pack`) — no local build step required, since `dist/` ships in the repository.

## Install

From GitHub (no local build required):

```sh
npm install github:nuupco/nuup-offline-kit expo-sqlite
```

Once published to npm:

```sh
npm install @nuup/offline-kit expo-sqlite
```

`expo-sqlite` (>=13) is a peer dependency and is not bundled.

### `dist/` policy

This package ships a committed `dist/` (`.js` + `.d.ts` + source maps) built by plain `tsc` (`npm run build`) from `src/**/*.ts`. CI (`npm run verify:dist`) fails whenever the committed `dist/` does not match a fresh rebuild of `src/`, so an installed Git/tarball checkout never needs a local TypeScript build. If you edit `src/`, run `npm run build` and commit the refreshed `dist/` alongside it.

### Migrating from 0.1.x (pre-TypeScript)

`main`/`types`/`exports` now point at `dist/` instead of `src/`; the public subpaths (`.`, `./migrations`, `./adapters/expo-sqlite`, plus the new `./sync`) are unchanged. `files` changed from `["src"]` to `["dist", "README.md", "LICENSE"]`. Consumers importing only the documented subpaths need no code changes — reinstall to pick up 0.2.0.

## Local usage (pre-npm)

While this package is not yet on the npm registry, consumer apps can install it from a tarball:

```sh
# in nuup-offline-kit
npm pack

# in the consumer app (e.g. mt_app_expo)
npm install file:../nuup-offline-kit/nuup-offline-kit-0.2.0.tgz
```

Regenerate and reinstall the tarball whenever this package's source changes.

## Migrations

`createMigrationRunner` applies an ordered list of migrations against an adapter, tracking applied versions and their checksums in a `_nuup_migrations` table.

```js
const { createMigrationRunner, createExpoSqliteAdapter } = require('@nuup/offline-kit');

const adapter = createExpoSqliteAdapter({ databaseName: 'app.db' });

const runner = createMigrationRunner({
  adapter,
  migrations: [
    {
      version: 1,
      statements: ['CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)'],
    },
    {
      version: 2,
      statements: [
        'ALTER TABLE users ADD COLUMN email TEXT',
        async exec => {
          await exec('UPDATE users SET email = ? WHERE email IS NULL', ['']);
        },
      ],
    },
  ],
  hooks: {
    onStart: version => console.log(`applying migration ${version}`),
    onComplete: version => console.log(`applied migration ${version}`),
    onError: (version, error) => console.error(`migration ${version} failed`, error),
  },
});

const { appliedVersions } = await runner.migrate();
```

Rules enforced by `validateMigrations`:

- `migrations` must be a non-empty array.
- Versions must be sequential integers starting at 1, with no gaps or duplicates.
- Each migration's `statements` must be a non-empty array of SQL strings and/or `async (exec) => {}` functions.
- Once a migration has been applied, its statements cannot change — a checksum mismatch throws. Add a new migration instead of editing an applied one.

Each pending migration runs inside a single `adapter.runInTransaction`, so a failing statement rolls back that migration's changes.

## Adapters

An adapter implements the minimal contract the migration runner needs:

```ts
run(sql: string, params?: any[], options?: object): Promise<{ rows: any[], rowsAffected: number, insertId?: number }>
runInTransaction(fn: (exec) => Promise<any>): Promise<any>
```

### expo-sqlite adapter

```js
const { createExpoSqliteAdapter } = require('@nuup/offline-kit/adapters/expo-sqlite');

// let the adapter open the database itself
const adapter = createExpoSqliteAdapter({ databaseName: 'app.db' });

// or hand it an already-open expo-sqlite database
const database = require('expo-sqlite').openDatabaseSync('app.db');
const adapter = createExpoSqliteAdapter({ database });
```

Exactly one of `databaseName` or `database` is required.

Transactions are serialized per adapter instance through an internal queue — two top-level `runInTransaction` calls never run concurrently, they run one after the other.

Inside a transaction, the callback receives `exec`, a scoped handle:

```js
await adapter.runInTransaction(async exec => {
  await exec('INSERT INTO users (name) VALUES (?)', ['alice']); // same as calling exec directly
  await exec.run('INSERT INTO users (name) VALUES (?)', ['bob']); // exec.run is an alias for exec
});
```

`exec` is frozen and additionally exposes `exec.runInTransaction`, which always rejects immediately (no `BEGIN`, no invoking its argument) — this is the supported way to signal that nesting a transaction inside another one is not allowed:

```js
await adapter.runInTransaction(async exec => {
  await exec.runInTransaction(async () => {}); // rejects: nested transactions are not supported
});
```

> Nesting via the adapter's own `adapter.runInTransaction` (instead of the `exec` passed to the outer transaction) is **not** detected and will hang, queued behind the transaction that contains it. Always use the `exec` argument for any query or nested logic inside a transaction.

This adapter intentionally avoids Node's `async_hooks`/`AsyncLocalStorage` — Hermes (React Native/Expo's JS engine) doesn't implement it, and requiring it would break Metro bundling for any consumer app.

## Sync engine

`createSyncEngine` pulls remote datasets into local SQLite tables through a consumer-injected `remote` adapter. It is **pull-only** — there is no push/upload API, no conflict resolution, and no incremental cursors; the consumer's `remote.fetch` owns pagination, auth, retry and any `since` parameterization.

```ts
import { createSyncEngine } from '@nuup/offline-kit/sync';
// or: import { createSyncEngine } from '@nuup/offline-kit';

const engine = createSyncEngine({
  adapter,
  remote: {
    async fetch({ table }) {
      const res = await fetch(`https://api.example.com/${table}`);
      return res.json();
    },
  },
  tables: [
    { name: 'assistants', strategy: 'replace', columns: ['id', 'name'] },
    { name: 'messages', strategy: 'upsert', columns: ['id', 'thread_id', 'body'], primaryKey: 'id' },
  ],
});

const summary = await engine.sync();
// { results: [{ table, strategy, count, syncedAt }, ...], errors: [{ table, error }, ...] }

const one = await engine.syncTable('assistants');
// { table: 'assistants', strategy: 'replace', count: <rows applied this sync>, syncedAt }

const state = await engine.getSyncState();
// Map<string, { syncedAt: string, rowCount: number }>
```

### Table config

Each entry in `tables` declares:

- `name` — the local table name (must already exist; migrations own DDL, not sync).
- `columns` — the only column names sync will ever read/write; extra fields on a remote row are ignored, never turned into SQL identifiers.
- `strategy: 'replace'` — deletes all rows then inserts the fetched rows, in one transaction.
- `strategy: 'upsert'` — requires `primaryKey`; inserts new rows and updates existing rows by that key, without duplicating.
- `allowEmpty` (replace only, default `false`) — when `remote.fetch` resolves `[]`, `'replace'` no-ops (keeps existing rows, does not touch sync state) unless `allowEmpty: true`, in which case the table is cleared and sync state records `rowCount: 0`.
- `batchSize` (optional) — chunks large payloads into batches of this size within the same transaction.

### Atomicity and `_nuup_sync_state`

Every `syncTable(name)` call applies the fetched rows and records `_nuup_sync_state` in exactly **one** `adapter.runInTransaction` — a mid-transaction failure rolls back both the table data and the sync-state row together, leaving prior state untouched. The `_nuup_sync_state(table_name TEXT PRIMARY KEY, synced_at TEXT, row_count INTEGER NOT NULL)` table itself is bootstrapped once via `adapter.run` (`CREATE TABLE IF NOT EXISTS`), outside any per-table transaction — matching how migrations bootstrap `_nuup_migrations`.

`sync()` isolates each configured table in its own transaction and iterates them in declared order: one table's `remote.fetch` rejection is recorded in `errors` without blocking the rest.

`count` in the returned `SyncTableResult` is the number of rows **applied in that sync**, not the table's total row count.

### SQL identifier safety

Table and column identifiers used in generated SQL come only from the declared `tables` config — never from a fetched row's own keys — and every value is passed as a bound parameter. This prevents a malicious or malformed remote payload from injecting SQL identifiers.

## Build & Testing

```sh
npm run build      # tsc -> dist/ (committed)
npm run typecheck  # tsc --noEmit, strict
npm test           # jest (ts-jest), incl. better-sqlite3-backed expo-sqlite fake
npm run verify:dist  # rebuilds and fails if dist/ drifted from src/
```
