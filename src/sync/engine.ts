import type {
  ReplaceTableConfig,
  ScopedExec,
  SyncEngine,
  SyncEngineConfig,
  SyncState,
  SyncSummary,
  SyncTableResult,
  TableConfig,
} from '../types';
import { validateSyncTables } from './validate';
import { applyReplace, applyUpsert } from './apply';
import { DEFAULT_SYNC_STATE_TABLE, ensureSyncStateTable, readAllSyncState, recordSyncState } from './state';

export function createSyncEngine({
  adapter,
  remote,
  tables,
  syncStateTable = DEFAULT_SYNC_STATE_TABLE,
  hooks = {},
}: SyncEngineConfig): SyncEngine {
  const validatedTables = validateSyncTables(tables);
  const byName = new Map<string, TableConfig>(validatedTables.map(table => [table.name, table]));
  const { onTableStart, onTableComplete, onTableError } = hooks;

  let bootstrapped: Promise<void> | undefined;
  function ensureBootstrap(): Promise<void> {
    if (!bootstrapped) {
      bootstrapped = ensureSyncStateTable(adapter, syncStateTable);
    }
    return bootstrapped;
  }

  async function applyTable(exec: ScopedExec, table: TableConfig, rows: Record<string, unknown>[]): Promise<number> {
    if (table.strategy === 'upsert') {
      return applyUpsert(exec, table, rows);
    }

    const replaceTable = table as ReplaceTableConfig;
    if (rows.length === 0 && !replaceTable.allowEmpty) {
      return -1; // sentinel: no-op, caller must not write sync-state
    }
    return applyReplace(exec, replaceTable, rows);
  }

  async function syncTable(name: string): Promise<SyncTableResult> {
    const table = byName.get(name);
    if (!table) {
      throw new Error(`syncTable: unknown table "${name}" — not present in the configured tables`);
    }

    await ensureBootstrap();

    if (onTableStart) onTableStart(name);

    try {
      const rows = await remote.fetch({ table: name });

      const result = await adapter.runInTransaction(async exec => {
        const count = await applyTable(exec, table, rows);
        if (count === -1) {
          return null;
        }
        await recordSyncState(exec, syncStateTable, name, count);
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
