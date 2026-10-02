# Feature: upsert-incremental-deletes (M1)

## Objective
Allow `UpsertTableConfig` tables to delete rows incrementally (row-level DELETE by primaryKey)
when the fetched row carries a non-null value in a configurable `deletedAtColumn`, in the same
pass/transaction as normal upserts. Requested by tlacuache_app (cross-session), which needs this
for `persons`/`huerta_personas`/`parcela_personas` against `tlacuache_api`'s `/changes?since=`
soft-delete payloads.

## Why
`applyUpsert` never deletes rows today; `applyReplace` only does full-table wipes. Neither
supports incremental soft-delete propagation from the backend.

## Scope (M1 only — M2 "since cursor" is a separate, not-yet-designed milestone)
- `src/types.ts`: add `deletedAtColumn?: string` to `UpsertTableConfig`.
- `src/sync/validate.ts`: require `deletedAtColumn` to be listed in `columns`; reject it on
  `replace` tables; reject `deletedAtColumn === primaryKey`.
- `src/sync/apply.ts`: `applyUpsert` branches per row — DELETE by primaryKey when
  `row[deletedAtColumn] != null`, else upsert as today. Null/missing primaryKey on a tombstoned
  row throws (rolls back transaction). Duplicate primaryKey in one payload: last occurrence in
  array order wins.
- README: document the new option, local-schema requirement, minimum kit version.

## Decisions (user-confirmed, do not re-litigate)
1. Deleted semantics: any non-null value in `deletedAtColumn` = deleted.
2. `deletedAtColumn` must be in `columns`.
3. Deletes count toward the same total `count`/`rowCount` — no new fields.
4. `deletedAtColumn` rejected on `replace` strategy.
5. Null/missing primaryKey on delete → throw + rollback.
6. Duplicate primaryKey in payload → last array occurrence wins.
7. `deletedAtColumn === primaryKey` → rejected in validation.

## Artifacts (Engram, project nuup-offline-kit)
- `sdd/upsert-incremental-deletes/proposal` (#2387)
- `sdd/upsert-incremental-deletes/spec` (#2388)
- `sdd/upsert-incremental-deletes/design` (#2389)
- `sdd/upsert-incremental-deletes/tasks` (#2390) — T1-T10, strict TDD

## Progress
- [x] Proposal, spec, design, tasks written and saved.
- [x] T1 — types: `UpsertTableConfig.deletedAtColumn` (RED confirmed via standalone `tsc`, GREEN).
- [x] T2 — validate.ts: accept + normalize `deletedAtColumn` on upsert (RED confirmed, GREEN).
- [x] T3 — validate.ts: reject `deletedAtColumn` on replace tables (RED confirmed, GREEN).
- [x] T4 — validate.ts: reject `deletedAtColumn === primaryKey` (RED confirmed, GREEN).
- [x] T5 — apply.ts: baseline unaffected when `deletedAtColumn` absent (RED confirmed, GREEN).
- [x] T6 — apply.ts: deleteSql construction + per-row branch (RED confirmed, GREEN).
- [x] T7 — apply.ts: tombstone with missing/null primary key throws + rolls back (RED confirmed, GREEN).
- [x] T8 — engine.ts integration: end-to-end tombstone sync (composed GREEN, as predicted by design).
- [x] T9 — engine.ts integration: replace + deletedAtColumn rejected at construction (composed GREEN, as predicted by design).
- [x] T10 — README documentation.
- [x] Verification: `npm test` (81/81 passed), `npm run typecheck` (clean), standalone `tsc --noEmit` on `__tests__/types/sync.ts` (clean — this file is excluded from `tsconfig.json`'s `include: ["src"]` and from Jest's testMatch, so it is type-checked via a standalone `tsc` invocation with equivalent compiler flags).
- [x] Work-unit commit on feature branch `feat/upsert-incremental-deletes`.

## Next step
sdd-archive.
