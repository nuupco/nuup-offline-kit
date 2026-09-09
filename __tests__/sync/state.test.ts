import { createFakeExpoSqliteDb } from '../helpers/fake-expo-sqlite';
import { createExpoSqliteAdapter } from '../../src/adapters/expo-sqlite';
import {
  DEFAULT_SYNC_STATE_TABLE,
  ensureSyncStateTable,
  recordSyncState,
  readSyncState,
  readAllSyncState,
} from '../../src/sync/state';

function makeAdapter() {
  const database = createFakeExpoSqliteDb();
  return createExpoSqliteAdapter({ database });
}

describe('sync/state', () => {
  it('creates the sync-state table via adapter.run outside any transaction', async () => {
    const adapter = makeAdapter();
    await ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE);

    const { rows } = await adapter.run(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      [DEFAULT_SYNC_STATE_TABLE]
    );
    expect(rows).toHaveLength(1);
  });

  it('is idempotent (CREATE TABLE IF NOT EXISTS)', async () => {
    const adapter = makeAdapter();
    await ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE);
    await expect(ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE)).resolves.not.toThrow();
  });

  it('records and reads back sync state inside a transaction-scoped exec', async () => {
    const adapter = makeAdapter();
    await ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE);

    await adapter.runInTransaction(async exec => {
      await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'assistants', 3);
    });

    const state = await readSyncState(adapter.run, DEFAULT_SYNC_STATE_TABLE, 'assistants');
    expect(state).toBeDefined();
    expect(state?.rowCount).toBe(3);
    expect(typeof state?.syncedAt).toBe('string');
  });

  it('readAllSyncState returns a Map keyed by table name', async () => {
    const adapter = makeAdapter();
    await ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE);

    await adapter.runInTransaction(async exec => {
      await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'assistants', 3);
      await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'threads', 5);
    });

    const all = await readAllSyncState(adapter, DEFAULT_SYNC_STATE_TABLE);
    expect(all).toBeInstanceOf(Map);
    expect(all.get('assistants')?.rowCount).toBe(3);
    expect(all.get('threads')?.rowCount).toBe(5);
  });

  it('recordSyncState upserts (updates in place, not duplicating) on repeated calls', async () => {
    const adapter = makeAdapter();
    await ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE);

    await adapter.runInTransaction(async exec => {
      await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'assistants', 3);
      await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'assistants', 7);
    });

    const { rows } = await adapter.run(`SELECT * FROM ${DEFAULT_SYNC_STATE_TABLE} WHERE table_name = ?`, [
      'assistants',
    ]);
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).row_count).toBe(7);
  });
});
