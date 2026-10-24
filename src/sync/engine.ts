import type {
  ReplaceTableConfig,
  ScopedExec,
  SyncEngine,
  SyncEngineConfig,
  SyncState,
  SyncSummary,
  SyncTableResult,
  TableConfig,
  UpsertTableConfig,
} from '../types';
import { validateSyncTables } from './validate';
import { applyReplace, applyUpsert, chunk, DEFAULT_BATCH_SIZE } from './apply';
import { DEFAULT_SYNC_STATE_TABLE, ensureSyncStateTable, readAllSyncState, readSyncState, recordSyncState } from './state';

export function createSyncEngine({
  adapter,
  remote,
  tables,
  syncStateTable = DEFAULT_SYNC_STATE_TABLE,
  hooks = {},
}: SyncEngineConfig): SyncEngine {
  const validatedTables = validateSyncTables(tables);
  const byName = new Map<string, TableConfig>(validatedTables.map(table => [table.name, table]));
  const { onTableStart, onTableComplete, onTableError, shouldApplyRow } = hooks;

  let bootstrapped: Promise<void> | undefined;
  function ensureBootstrap(): Promise<void> {
    if (!bootstrapped) {
      bootstrapped = ensureSyncStateTable(adapter, syncStateTable);
    }
    return bootstrapped;
  }

  async function applyReplaceTable(
    exec: ScopedExec,
    table: ReplaceTableConfig,
    rows: Record<string, unknown>[]
  ): Promise<number> {
    if (rows.length === 0 && !table.allowEmpty) {
      return -1; // sentinel: no-op, caller must not write sync-state
    }
    return applyReplace(exec, table, rows);
  }

  // `cursor: undefined` means "this fetch call didn't report a cursor" (either
  // a plain-array result, or an object that omitted it) — in that case the
  // previously persisted cursor must be kept, not wiped to null.
  function normalizeFetchResult(
    result: Record<string, unknown>[] | { rows: Record<string, unknown>[]; cursor?: string | null }
  ): { rows: Record<string, unknown>[]; cursor: string | null | undefined } {
    if (Array.isArray(result)) {
      return { rows: result, cursor: undefined };
    }
    return { rows: result.rows, cursor: result.cursor };
  }

  // Each batch commits in its own short transaction instead of one
  // transaction for the whole table: on a large pull, holding a single
  // transaction open for thousands of rows blocks every other write on the
  // shared connection for the duration. 'upsert' rows are idempotent, so a
  // partial commit (earlier batches persisted, a later one rejected) is safe
  // to retry — unlike 'replace', which keeps its single transaction because
  // its DELETE+INSERT must stay all-or-nothing.
  async function syncUpsertTable(
    table: UpsertTableConfig,
    name: string,
    rows: Record<string, unknown>[],
    cursor: string | null
  ): Promise<number> {
    const applicableRows = shouldApplyRow ? rows.filter(row => shouldApplyRow(name, row)) : rows;
    const batches = chunk(applicableRows, table.batchSize ?? DEFAULT_BATCH_SIZE);
    let count = 0;
    for (const batch of batches) {
      count += await adapter.runInTransaction(exec => applyUpsert(exec, table, batch));
    }
    await adapter.runInTransaction(exec => recordSyncState(exec, syncStateTable, name, count, cursor));
    return count;
  }

  async function syncTable(name: string): Promise<SyncTableResult> {
    const table = byName.get(name);
    if (!table) {
      throw new Error(`syncTable: unknown table "${name}" — not present in the configured tables`);
    }

    await ensureBootstrap();

    if (onTableStart) onTableStart(name);

    try {
      const previousCursor = (await readSyncState(adapter.run, syncStateTable, name))?.cursor ?? null;
      const fetched = await remote.fetch({ table: name, since: previousCursor });
      const { rows, cursor: fetchedCursor } = normalizeFetchResult(fetched);
      const cursor = fetchedCursor === undefined ? previousCursor : fetchedCursor;

      const result =
        table.strategy === 'upsert'
          ? await syncUpsertTable(table, name, rows, cursor)
          : await adapter.runInTransaction(async exec => {
              const count = await applyReplaceTable(exec, table as ReplaceTableConfig, rows);
              if (count === -1) {
                return null;
              }
              await recordSyncState(exec, syncStateTable, name, count, cursor);
              return count;
            });

      if (result === null) {
        // Empty payload, replace strategy without allowEmpty: no-op.
        const existing = await readAllSyncState(adapter, syncStateTable);
        const previous = existing.get(name);
        const syncResult: SyncTableResult = {
          table: name,
          strategy: table.strategy,
          count: 0,
          syncedAt: previous?.syncedAt ?? new Date().toISOString(),
        };
        if (onTableComplete) onTableComplete(syncResult);
        return syncResult;
      }

      const state = await readAllSyncState(adapter, syncStateTable);
      const syncResult: SyncTableResult = {
        table: name,
        strategy: table.strategy,
        count: result,
        syncedAt: state.get(name)?.syncedAt ?? new Date().toISOString(),
      };
      if (onTableComplete) onTableComplete(syncResult);
      return syncResult;
    } catch (error) {
      if (onTableError) onTableError(name, error);
      throw error;
    }
  }

  async function sync(): Promise<SyncSummary> {
    const results: SyncTableResult[] = [];
    const errors: { table: string; error: unknown }[] = [];

    for (const table of validatedTables) {
      try {
        const result = await syncTable(table.name);
        results.push(result);
      } catch (error) {
        errors.push({ table: table.name, error });
      }
    }

    return { results, errors };
  }

  async function getSyncState(): Promise<Map<string, SyncState>> {
    await ensureBootstrap();
    return readAllSyncState(adapter, syncStateTable);
  }

  return { sync, syncTable, getSyncState };
}
