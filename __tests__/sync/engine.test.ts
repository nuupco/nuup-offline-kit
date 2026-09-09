import { createFakeExpoSqliteDb } from '../helpers/fake-expo-sqlite';
import { createExpoSqliteAdapter } from '../../src/adapters/expo-sqlite';
import { createSyncEngine } from '../../src/sync/engine';
import { DEFAULT_SYNC_STATE_TABLE } from '../../src/sync/state';
import type { RemoteSource, TableConfig } from '../../src/types';

function makeAdapter() {
  const database = createFakeExpoSqliteDb();
  return createExpoSqliteAdapter({ database });
}

function makeRemote(data: Record<string, Record<string, unknown>[] | (() => Promise<Record<string, unknown>[]>)>): RemoteSource {
  return {
    async fetch({ table }) {
      const entry = data[table];
      if (typeof entry === 'function') return entry();
      if (entry === undefined) throw new Error(`no fixture for table "${table}"`);
      return entry;
    },
  };
}

describe('createSyncEngine', () => {
  it('returns exactly sync, syncTable, getSyncState', async () => {
    const adapter = makeAdapter();
    const engine = createSyncEngine({
      adapter,
      remote: makeRemote({}),
      tables: [{ name: 'assistants', strategy: 'replace', columns: ['id', 'name'] }],
    });

    expect(Object.keys(engine).sort()).toEqual(['getSyncState', 'sync', 'syncTable']);
  });

  it('validates tables at construction, before touching adapter or remote', () => {
    const adapter = makeAdapter();
    const runSpy = jest.spyOn(adapter, 'run');
    let fetchCalled = false;
    const remote: RemoteSource = {
      async fetch() {
        fetchCalled = true;
        return [];
      },
    };

    expect(() => createSyncEngine({ adapter, remote, tables: [] })).toThrow(/non-empty/);
    expect(runSpy).not.toHaveBeenCalled();
    expect(fetchCalled).toBe(false);
  });

  describe('syncTable — replace strategy', () => {
    const tables: TableConfig[] = [{ name: 'assistants', strategy: 'replace', columns: ['id', 'name'] }];

    it('replaces prior rows atomically and updates sync state in the same transaction', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'stale')");

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 2, name: 'alice' }] }),
        tables,
      });

      const result = await engine.syncTable('assistants');

      expect(result).toEqual({ table: 'assistants', strategy: 'replace', count: 1, syncedAt: expect.any(String) });
      const { rows } = await adapter.run('SELECT id, name FROM assistants');
      expect(rows).toEqual([{ id: 2, name: 'alice' }]);

      const state = await engine.getSyncState();
      expect(state.get('assistants')?.rowCount).toBe(1);
    });

    it('bootstraps _nuup_sync_state via adapter.run outside the per-table transaction, only once', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      const runInTransactionSpy = jest.spyOn(adapter, 'runInTransaction');

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 1, name: 'alice' }] }),
        tables,
      });

      await engine.syncTable('assistants');
      await engine.syncTable('assistants');

      const { rows } = await adapter.run(
        `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        [DEFAULT_SYNC_STATE_TABLE]
      );
      expect(rows).toHaveLength(1);
      // both syncTable calls used exactly one runInTransaction each — the
      // bootstrap itself never ran inside a per-table transaction.
      expect(runInTransactionSpy).toHaveBeenCalledTimes(2);
    });

    it('rolls back and leaves rows and sync-state unchanged on mid-transaction failure', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'alice')");

      const engine = createSyncEngine({
        adapter,
        // second row has a NULL name, which violates NOT NULL and throws mid-transaction
        remote: makeRemote({ assistants: [{ id: 2, name: 'bob' }, { id: 3, name: null }] }),
        tables,
      });

      await expect(engine.syncTable('assistants')).rejects.toThrow();

      const { rows } = await adapter.run('SELECT id, name FROM assistants');
      expect(rows).toEqual([{ id: 1, name: 'alice' }]);

      const state = await engine.getSyncState();
      expect(state.get('assistants')).toBeUndefined();
    });

    it('does not wipe the table on an empty payload by default', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'alice')");

      const engine = createSyncEngine({ adapter, remote: makeRemote({ assistants: [] }), tables });

      const result = await engine.syncTable('assistants');
      expect(result.count).toBe(0);

      const { rows } = await adapter.run('SELECT id, name FROM assistants');
      expect(rows).toEqual([{ id: 1, name: 'alice' }]);

      const state = await engine.getSyncState();
      expect(state.get('assistants')).toBeUndefined();
    });

    it('wipes the table and writes row_count 0 when allowEmpty is true', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'alice')");

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [] }),
        tables: [{ name: 'assistants', strategy: 'replace', columns: ['id', 'name'], allowEmpty: true }],
      });

      const result = await engine.syncTable('assistants');
      expect(result.count).toBe(0);

      const { rows } = await adapter.run('SELECT id, name FROM assistants');
      expect(rows).toEqual([]);

      const state = await engine.getSyncState();
      expect(state.get('assistants')?.rowCount).toBe(0);
    });
  });

  describe('syncTable — upsert strategy', () => {
    it('updates existing rows in place without duplicating', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'old-name')");

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 1, name: 'new-name' }, { id: 2, name: 'carol' }] }),
        tables: [{ name: 'assistants', strategy: 'upsert', columns: ['id', 'name'], primaryKey: 'id' }],
      });

      const result = await engine.syncTable('assistants');
      expect(result.count).toBe(2);

      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'new-name' },
        { id: 2, name: 'carol' },
      ]);
    });
  });

  describe('sync()', () => {
    it('iterates all tables in declared order, isolating each in its own transaction', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      await adapter.run('CREATE TABLE threads (id INTEGER PRIMARY KEY, title TEXT)');

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({
          assistants: [{ id: 1, name: 'alice' }],
          threads: [{ id: 1, title: 'welcome' }],
        }),
        tables: [
          { name: 'assistants', strategy: 'replace', columns: ['id', 'name'] },
          { name: 'threads', strategy: 'replace', columns: ['id', 'title'] },
        ],
      });

      const summary = await engine.sync();

      expect(summary.errors).toEqual([]);
      expect(summary.results.map((r: any) => r.table)).toEqual(['assistants', 'threads']);
    });

    it("one table's fetch rejection does not prevent the others from being attempted", async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      await adapter.run('CREATE TABLE threads (id INTEGER PRIMARY KEY, title TEXT)');

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ threads: [{ id: 1, title: 'welcome' }] }), // assistants fixture missing -> throws
        tables: [
          { name: 'assistants', strategy: 'replace', columns: ['id', 'name'] },
          { name: 'threads', strategy: 'replace', columns: ['id', 'title'] },
        ],
      });

      const summary = await engine.sync();

      expect(summary.errors).toHaveLength(1);
      expect(summary.errors[0].table).toBe('assistants');
      expect(summary.results.map((r: any) => r.table)).toEqual(['threads']);
    });
  });

  describe('Hermes/static boundary', () => {
    it('the engine module only references the adapter contract, no Node-core import', () => {
      // eslint-disable-next-line global-require
      const fs = require('fs');
      // eslint-disable-next-line global-require
      const path = require('path');
      const source = fs.readFileSync(path.join(__dirname, '../../src/sync/engine.ts'), 'utf8');
      expect(source).not.toMatch(/require\(['"]node:/);
      expect(source).not.toMatch(/async_hooks/);
      expect(source).not.toMatch(/AsyncLocalStorage/);
    });
  });
});
