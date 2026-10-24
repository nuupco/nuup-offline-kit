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
