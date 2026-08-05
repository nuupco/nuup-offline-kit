# @nuup/offline-kit

Offline-first toolkit for React Native/Expo apps: SQLite migrations, a bidirectional sync engine, and a query/store abstraction.

> Status: not yet published to npm. Consumed by installing a tarball generated with `npm pack` (see [Local usage](#local-usage-pre-npm) below).

## Install

Once published:

```sh
npm install @nuup/offline-kit expo-sqlite
```

`expo-sqlite` (>=13) is a peer dependency and is not bundled.

## Local usage (pre-npm)

While this package is not yet on the npm registry, consumer apps install it from a tarball:

```sh
# in nuup-offline-kit
npm pack

# in the consumer app (e.g. mt_app_expo)
npm install file:../nuup-offline-kit/nuup-offline-kit-0.1.0.tgz
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

## Testing

```sh
npm test
```

Runs the Jest suite, including a `better-sqlite3`-backed fake for `expo-sqlite` used by the adapter's integration tests.
