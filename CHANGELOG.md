# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Incremental pull: `RemoteSource.fetch` now receives `since` (the table's
  persisted cursor, or `null` on the first sync) and may return
  `{ rows, cursor }` instead of a plain array; the returned `cursor` is
  persisted to `_nuup_sync_state` and passed back as `since` on the next
  sync. Existing `RemoteSource` implementations that return a plain array
  keep working unchanged — they just don't get incremental cursors.
- `_nuup_sync_state` gained a `cursor` column (auto-migrated in place via
  `ensureSyncStateTable` for tables created by older versions).
- `ReplaceTableConfig.useShadowTable`: opt-in shadow-table swap for the
  `replace` strategy (`${table.name}__shadow`, built from the table's own
  `sqlite_master` schema, then atomically swapped in). Default is `false`,
  keeping the existing DELETE+INSERT behavior unless opted in. Recovers
  automatically from a leftover shadow table left by a previously
  interrupted sync. Known limitation: indexes/triggers declared via separate
  `CREATE INDEX`/`CREATE TRIGGER` statements are not recreated on the new
  table.
- `UpsertTableConfig.preserveColumns`: columns listed here still receive
  their given value on `INSERT` (new row) but are excluded from the `SET`
  clause of `ON CONFLICT ... DO UPDATE` (existing row keeps its current
  local value instead of being overwritten by the synced value). Useful for
  local bookkeeping columns (e.g. a dirty flag or local-edit timestamp) that
  should only ever be seeded once. Must each be listed in `columns`; only
  supported for the `upsert` strategy. If `preserveColumns` leaves no column
  to update, the upsert falls back to `ON CONFLICT ... DO NOTHING`.
- Write batching: `applyReplace`, `applyReplaceShadow`, and `applyUpsert` now
  send one multi-row `INSERT ... VALUES (...), (...)` per batch instead of
  one `INSERT` per row, cutting adapter roundtrips. For `applyUpsert`,
  consecutive non-tombstoned rows with distinct primary keys are grouped
  into one statement; a tombstoned row still runs its own `DELETE`, and a
  run breaks early if the same primary key would otherwise appear twice in
  one multi-row statement (SQLite only resolves `ON CONFLICT` against rows
  that existed before the statement ran). Behavior and row counts are
  unchanged — this only reduces the number of SQL statements executed.
- Paginated pull: `RemoteSource.fetch` may now additionally return an async
  iterable of pages (each page the same `Row[]` or `{ rows, cursor }` shape
  as before) instead of a single result. The engine consumes pages with
  `for await`, applying each one incrementally (same batching as before) for
  `upsert` tables, and keeps the cursor from the last page that reports one.
  `replace`-strategy tables accumulate all pages before their atomic
  DELETE+INSERT/shadow swap, since that strategy can't apply partially. This
  is additive: a `fetch` returning a plain array or `{ rows, cursor }` keeps
  working unchanged.
- Observability hooks: `SyncHooks.onBatchComplete({ table, batchIndex,
  batchSize, durationMs })` fires after each committed batch (once per
  `batchSize` chunk for `upsert`, once per table for `replace`/shadow, since
  that strategy has only one logical batch). `SyncHooks.onSyncStart()` and
  `SyncHooks.onSyncComplete(summary)` fire once around `sync()` (not
  `syncTable()`).

- `createPushEngine({ adapter, pushStateTable?, maxAttempts?, backoff?, baseDelayMs?, maxBackoffMs?, hooks? })`:
  a generic outbox/push engine for queuing local mutations to send to a
  server. `enqueue(mutation)` inserts a `{ id, type, payload, dependsOn? }`
  mutation as `pending` (idempotent by `id`: re-enqueuing a still-`pending`
  mutation refreshes its payload/dependsOn; a mutation already
  `in_flight`/`done`/`failed` is left untouched). `processQueue({ send })`
  picks up `pending` mutations whose `dependsOn` (if any) is already `done`
  and whose backoff window has elapsed, marks each `in_flight`, calls the
  caller-supplied `send(mutation)`, and on success marks it `done` or on
  failure increments `attempts` and either reschedules it with exponential
  backoff (`2^attempts * baseDelayMs`, capped at `maxBackoffMs`, both
  configurable, or a fully custom `backoff(attempts)` function) or marks it
  `failed` once `maxAttempts` (default 5) is reached. A mutation with an
  unresolved `dependsOn` is skipped, never failed. State is persisted in a
  new bookkeeping table (default `_nuup_push_outbox`, configurable via
  `pushStateTable`), auto-created via `ensurePushOutboxTable`.
  `listByStatus(status)` and `getQueueState()` expose the queue for
  inspection (e.g. a "N changes pending to upload" UI). Optional
  `onMutationStart`/`onMutationDone`/`onMutationFailed` hooks mirror the
  style of `SyncHooks`. The kit knows nothing about HTTP — `send` is
  entirely the caller's responsibility. Known limitations: a mutation whose
  `dependsOn` points to an id that never existed stays pending forever with
  no error; re-`enqueue`ing an already-`failed` mutation is a silent no-op
  (no built-in way to retry a failed mutation by id).

### Changed

- `SyncTableResult` gained `skipped` (rows discarded by `shouldApplyRow`,
  always `0` for `replace`), `upserts` (INSERT/UPDATE rows), and `deletes`
  (tombstone DELETE rows, always `0` for `replace`). `count` keeps its prior
  meaning — the total rows applied (`upserts + deletes`) — so existing code
  reading only `count` is unaffected.

### Fixed

- `createExpoSqliteAdapter`'s transaction rollback no longer masks the
  original error when the `ROLLBACK` statement itself throws (e.g. on an
  already-closed connection) — the original error is now always the one
  surfaced to the caller.

## [0.4.0]

### Added

- `shouldApplyRow` hook to guard upsert rows against local edits (#9).

## [0.3.2]

### Fixed

- Serialize `adapter.run()` behind in-flight transactions (#7).

## [0.3.1]

### Fixed

- Commit upsert batches in separate transactions (#5).

## [0.3.0]

### Added

- Incremental deletes via `deletedAtColumn` (#3).

## [0.2.1]

### Changed

- Docs-only release (#2).

## [0.2.0]

### Added

- TypeScript migration and pull-only sync engine.

### Fixed

- CI bumped to Node 22 to match the `better-sqlite3` engine requirement.
- Corrected GitHub install URL and dropped a redundant prepare build step.

### Documentation

- Added README covering migrations, the adapter contract, and local tarball install.

## [0.1.0]

### Added

- Initial migration engine and expo-sqlite adapter with Hermes-compatible behavior.
