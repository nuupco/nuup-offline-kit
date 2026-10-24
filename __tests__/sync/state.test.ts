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

  describe('cursor watermark', () => {
    it('persists and reads back a cursor via recordSyncState/readSyncState', async () => {
      const adapter = makeAdapter();
      await ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE);

      await adapter.runInTransaction(async exec => {
        await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'assistants', 3, '2026-10-24T10:00:00Z');
      });

      const state = await readSyncState(adapter.run, DEFAULT_SYNC_STATE_TABLE, 'assistants');
      expect(state?.cursor).toBe('2026-10-24T10:00:00Z');
    });

    it('defaults cursor to null when never passed', async () => {
      const adapter = makeAdapter();
      await ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE);

      await adapter.runInTransaction(async exec => {
        await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'assistants', 3);
      });

      const state = await readSyncState(adapter.run, DEFAULT_SYNC_STATE_TABLE, 'assistants');
      expect(state?.cursor).toBeNull();
    });

    it('overwrites a previous cursor with null when recordSyncState is called without one', async () => {
      const adapter = makeAdapter();
      await ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE);

      await adapter.runInTransaction(async exec => {
        await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'assistants', 3, 'cursor-1');
        await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'assistants', 5);
      });

      const state = await readSyncState(adapter.run, DEFAULT_SYNC_STATE_TABLE, 'assistants');
      expect(state?.cursor).toBeNull();
    });

    it('includes cursor in readAllSyncState', async () => {
      const adapter = makeAdapter();
      await ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE);

      await adapter.runInTransaction(async exec => {
        await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'assistants', 3, 'cursor-xyz');
      });

      const all = await readAllSyncState(adapter, DEFAULT_SYNC_STATE_TABLE);
      expect(all.get('assistants')?.cursor).toBe('cursor-xyz');
    });

    it('adds the cursor column via ALTER TABLE when ensureSyncStateTable runs against a pre-existing table created before this column existed', async () => {
      const adapter = makeAdapter();
      // Simulate an app that already has the old-shape table from before this change.
      await adapter.run(
        `CREATE TABLE ${DEFAULT_SYNC_STATE_TABLE} (
          table_name TEXT PRIMARY KEY,
          synced_at TEXT DEFAULT (datetime('now')),
          row_count INTEGER NOT NULL
        )`
      );
      await adapter.run(`INSERT INTO ${DEFAULT_SYNC_STATE_TABLE} (table_name, row_count) VALUES ('legacy', 1)`);

      await ensureSyncStateTable(adapter, DEFAULT_SYNC_STATE_TABLE);

      const state = await readSyncState(adapter.run, DEFAULT_SYNC_STATE_TABLE, 'legacy');
      expect(state?.rowCount).toBe(1);
      expect(state?.cursor).toBeNull();

      await adapter.runInTransaction(async exec => {
        await recordSyncState(exec, DEFAULT_SYNC_STATE_TABLE, 'legacy', 2, 'new-cursor');
      });
      const updated = await readSyncState(adapter.run, DEFAULT_SYNC_STATE_TABLE, 'legacy');
      expect(updated?.cursor).toBe('new-cursor');
    });
  });
});
