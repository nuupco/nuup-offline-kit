import type { Adapter, Exec, ScopedExec, SyncState } from '../types';
import { assertIdentifier } from './validate';

export const DEFAULT_SYNC_STATE_TABLE = '_nuup_sync_state';

export async function ensureSyncStateTable(adapter: Adapter, syncStateTable: string): Promise<void> {
  assertIdentifier(syncStateTable, 'syncStateTable');
  await adapter.run(
    `CREATE TABLE IF NOT EXISTS ${syncStateTable} (
      table_name TEXT PRIMARY KEY,
      synced_at TEXT DEFAULT (datetime('now')),
      row_count INTEGER NOT NULL,
      cursor TEXT
    )`
  );
  // Upgrade path: a table created before the cursor column existed.
  const { rows } = await adapter.run<{ name: string }>(`PRAGMA table_info(${syncStateTable})`);
  const hasCursor = rows.some(row => row.name === 'cursor');
  if (!hasCursor) {
    await adapter.run(`ALTER TABLE ${syncStateTable} ADD COLUMN cursor TEXT`);
  }
}

export async function recordSyncState(
  exec: ScopedExec,
  syncStateTable: string,
  table: string,
  rowCount: number,
  cursor: string | null = null
): Promise<void> {
  assertIdentifier(syncStateTable, 'syncStateTable');
  await exec(
    `INSERT INTO ${syncStateTable} (table_name, synced_at, row_count, cursor) VALUES (?, datetime('now'), ?, ?)
     ON CONFLICT(table_name) DO UPDATE SET synced_at = excluded.synced_at, row_count = excluded.row_count, cursor = excluded.cursor`,
    [table, rowCount, cursor]
  );
}

export async function readSyncState(
  exec: Exec,
  syncStateTable: string,
  table: string
): Promise<SyncState | undefined> {
  assertIdentifier(syncStateTable, 'syncStateTable');
  const { rows } = await exec<{ synced_at: string; row_count: number; cursor: string | null }>(
    `SELECT synced_at, row_count, cursor FROM ${syncStateTable} WHERE table_name = ?`,
    [table]
  );
  const row = rows[0];
  if (!row) return undefined;
  return { syncedAt: row.synced_at, rowCount: row.row_count, cursor: row.cursor };
}

export async function readAllSyncState(adapter: Adapter, syncStateTable: string): Promise<Map<string, SyncState>> {
  assertIdentifier(syncStateTable, 'syncStateTable');
  const { rows } = await adapter.run<{ table_name: string; synced_at: string; row_count: number; cursor: string | null }>(
    `SELECT table_name, synced_at, row_count, cursor FROM ${syncStateTable}`
  );
  const map = new Map<string, SyncState>();
  rows.forEach(row => map.set(row.table_name, { syncedAt: row.synced_at, rowCount: row.row_count, cursor: row.cursor }));
  return map;
}
