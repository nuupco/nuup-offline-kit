import { createFakeExpoSqliteDb } from '../helpers/fake-expo-sqlite';
import { createExpoSqliteAdapter } from '../../src/adapters/expo-sqlite';
import { createSyncEngine } from '../../src/sync/engine';
import { DEFAULT_SYNC_STATE_TABLE, readAllSyncState } from '../../src/sync/state';
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

      expect(result).toEqual({ table: 'assistants', strategy: 'replace', count: 1, skipped: 0, upserts: 1, deletes: 0, syncedAt: expect.any(String) });
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

    it('deletes tombstoned rows and upserts live rows when deletedAtColumn is configured', async () => {
      const adapter = makeAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)'
      );
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'old-name')");
      await adapter.run("INSERT INTO assistants (id, name) VALUES (2, 'to-remove')");

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({
          assistants: [
            { id: 1, name: 'new-name', deleted_at: null },
            { id: 2, name: 'to-remove', deleted_at: '2026-09-01T00:00:00Z' },
            { id: 3, name: 'carol', deleted_at: null },
          ],
        }),
        tables: [
          {
            name: 'assistants',
            strategy: 'upsert',
            columns: ['id', 'name', 'deleted_at'],
            primaryKey: 'id',
            deletedAtColumn: 'deleted_at',
          },
        ],
      });

      const result = await engine.syncTable('assistants');
      expect(result.count).toBe(3);

      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'new-name' },
        { id: 3, name: 'carol' },
      ]);

      const state = await engine.getSyncState();
      expect(state.get('assistants')?.rowCount).toBe(3);
      expect(result.count).toBe(state.get('assistants')?.rowCount);
    });

    it('rejects syncTable and leaves rows and sync-state unchanged when a tombstoned row has a null primary key', async () => {
      const adapter = makeAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)'
      );
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'alice')");

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({
          assistants: [{ id: null, name: 'ghost', deleted_at: '2026-09-01T00:00:00Z' }],
        }),
        tables: [
          {
            name: 'assistants',
            strategy: 'upsert',
            columns: ['id', 'name', 'deleted_at'],
            primaryKey: 'id',
            deletedAtColumn: 'deleted_at',
          },
        ],
      });

      await expect(engine.syncTable('assistants')).rejects.toThrow();

      const { rows } = await adapter.run('SELECT id, name FROM assistants');
      expect(rows).toEqual([{ id: 1, name: 'alice' }]);

      const state = await engine.getSyncState();
      expect(state.get('assistants')).toBeUndefined();
    });

    it('commits each upsert batch in its own transaction instead of one transaction for the whole table', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      const runInTransactionSpy = jest.spyOn(adapter, 'runInTransaction');

      const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `name-${i + 1}` }));
      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: rows }),
        tables: [{ name: 'assistants', strategy: 'upsert', columns: ['id', 'name'], primaryKey: 'id', batchSize: 4 }],
      });

      const result = await engine.syncTable('assistants');

      expect(result.count).toBe(10);
      // 3 batches (4 + 4 + 2) plus one final transaction to record sync state.
      expect(runInTransactionSpy).toHaveBeenCalledTimes(4);
      const { rows: stored } = await adapter.run('SELECT id FROM assistants ORDER BY id');
      expect(stored).toHaveLength(10);

      const state = await engine.getSyncState();
      expect(state.get('assistants')?.rowCount).toBe(10);
    });

    it('keeps earlier successful upsert batches committed when a later batch fails (batches are not all-or-nothing)', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');

      // Batch 1 (ids 1-2) is valid; batch 2 (ids 3-4) has a NULL name and violates NOT NULL.
      const rows = [
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
        { id: 3, name: null },
        { id: 4, name: 'dave' },
      ];
      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: rows }),
        tables: [{ name: 'assistants', strategy: 'upsert', columns: ['id', 'name'], primaryKey: 'id', batchSize: 2 }],
      });

      await expect(engine.syncTable('assistants')).rejects.toThrow();

      const { rows: stored } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(stored).toEqual([
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
      ]);

      // The failure happened before the final recordSyncState transaction, so no watermark was written.
      const state = await engine.getSyncState();
      expect(state.get('assistants')).toBeUndefined();
    });

    it('skips a row when shouldApplyRow returns false, leaving the local copy untouched, and still applies the rest', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (2, 'local-pending-edit')");

      const seen: { table: string; row: Record<string, unknown> }[] = [];
      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({
          assistants: [
            { id: 1, name: 'alice' },
            { id: 2, name: 'stale-remote' },
          ],
        }),
        tables: [{ name: 'assistants', strategy: 'upsert', columns: ['id', 'name'], primaryKey: 'id' }],
        hooks: {
          shouldApplyRow: (table, row) => {
            seen.push({ table, row });
            return row.id !== 2;
          },
        },
      });

      const result = await engine.syncTable('assistants');

      expect(result.count).toBe(1);
      expect(seen).toEqual([
        { table: 'assistants', row: { id: 1, name: 'alice' } },
        { table: 'assistants', row: { id: 2, name: 'stale-remote' } },
      ]);

      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'alice' },
        { id: 2, name: 'local-pending-edit' },
      ]);
    });

    it('does not call shouldApplyRow for a replace-strategy table', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

      const shouldApplyRow = jest.fn().mockReturnValue(true);
      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 1, name: 'alice' }] }),
        tables: [{ name: 'assistants', strategy: 'replace', columns: ['id', 'name'] }],
        hooks: { shouldApplyRow },
      });

      await engine.syncTable('assistants');

      expect(shouldApplyRow).not.toHaveBeenCalled();
    });

    it('rejects createSyncEngine when a replace-strategy table declares deletedAtColumn, before touching adapter or remote', () => {
      const adapter = makeAdapter();
      const runSpy = jest.spyOn(adapter, 'run');
      let fetchCalled = false;
      const remote: RemoteSource = {
        async fetch() {
          fetchCalled = true;
          return [];
        },
      };

      expect(() =>
        createSyncEngine({
          adapter,
          remote,
          tables: [
            {
              name: 'assistants',
              strategy: 'replace',
              columns: ['id', 'name', 'deleted_at'],
              deletedAtColumn: 'deleted_at',
            } as unknown as TableConfig,
          ],
        })
      ).toThrow(/deletedAtColumn/);
      expect(runSpy).not.toHaveBeenCalled();
      expect(fetchCalled).toBe(false);
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

  describe("syncTable — replace strategy with useShadowTable: true", () => {
    const shadowTables: TableConfig[] = [
      { name: 'assistants', strategy: 'replace', columns: ['id', 'name'], useShadowTable: true },
    ];

    it('swaps in new rows and preserves the schema (PRIMARY KEY still enforced after sync)', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'stale')");

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 2, name: 'alice' }] }),
        tables: shadowTables,
      });

      const result = await engine.syncTable('assistants');

      expect(result).toEqual({ table: 'assistants', strategy: 'replace', count: 1, skipped: 0, upserts: 1, deletes: 0, syncedAt: expect.any(String) });
      const { rows } = await adapter.run('SELECT id, name FROM assistants');
      expect(rows).toEqual([{ id: 2, name: 'alice' }]);
      await expect(adapter.run('INSERT INTO assistants (id, name) VALUES (2, \'dup\')')).rejects.toThrow();
    });

    it('leaves the original table untouched when the fetched rows violate the schema', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'stale')");

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 2, name: null }] }),
        tables: shadowTables,
      });

      await expect(engine.syncTable('assistants')).rejects.toThrow();
      const { rows } = await adapter.run('SELECT id, name FROM assistants');
      expect(rows).toEqual([{ id: 1, name: 'stale' }]);
    });

    it('actually drives the shadow-table swap path, not a plain DELETE+INSERT, when useShadowTable is true', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      const executed: string[] = [];
      const realRunInTransaction = adapter.runInTransaction.bind(adapter);
      (adapter as any).runInTransaction = (fn: any) =>
        realRunInTransaction((exec: any) => {
          const recordingExec = ((sql: string, params?: unknown[], options?: unknown) => {
            executed.push(sql);
            return exec(sql, params, options);
          }) as any;
          return fn(recordingExec);
        });

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 1, name: 'alice' }] }),
        tables: shadowTables,
      });
      await engine.syncTable('assistants');

      expect(executed.some(sql => /ALTER TABLE .* RENAME TO assistants/i.test(sql))).toBe(true);
      expect(executed.some(sql => /CREATE TABLE assistants__shadow/i.test(sql))).toBe(true);
      expect(executed.some(sql => /^\s*DELETE FROM assistants\s*$/i.test(sql))).toBe(false);
    });

    it('recovers via the engine when a previous crashed sync left a stale shadow table behind', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      await adapter.run('CREATE TABLE assistants__shadow (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      await adapter.run("INSERT INTO assistants__shadow (id, name) VALUES (99, 'orphaned')");

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 1, name: 'alice' }] }),
        tables: shadowTables,
      });
      await engine.syncTable('assistants');

      const { rows } = await adapter.run('SELECT id, name FROM assistants');
      expect(rows).toEqual([{ id: 1, name: 'alice' }]);
    });
  });

  describe('syncTable — upsert strategy with preserveColumns', () => {
    it('propagates preserveColumns from config through to the UPDATE SQL actually executed (not just the visible data result)', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, is_dirty INTEGER)');
      await adapter.run("INSERT INTO assistants (id, name, is_dirty) VALUES (1, 'old', 1)");

      const executed: string[] = [];
      const realRunInTransaction = adapter.runInTransaction.bind(adapter);
      (adapter as any).runInTransaction = (fn: any) =>
        realRunInTransaction((exec: any) => {
          const recordingExec = ((sql: string, params?: unknown[], options?: unknown) => {
            executed.push(sql);
            return exec(sql, params, options);
          }) as any;
          return fn(recordingExec);
        });

      const tables: TableConfig[] = [
        {
          name: 'assistants',
          strategy: 'upsert',
          primaryKey: 'id',
          columns: ['id', 'name', 'is_dirty'],
          preserveColumns: ['is_dirty'],
        },
      ];
      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 1, name: 'new', is_dirty: 0 }] }),
        tables,
      });

      await engine.syncTable('assistants');

      const insertSql = executed.find(sql => sql.startsWith('INSERT'));
      expect(insertSql).toContain('is_dirty');
      expect(insertSql).not.toMatch(/is_dirty = excluded\.is_dirty/);

      const { rows } = await adapter.run('SELECT id, name, is_dirty FROM assistants');
      expect(rows).toEqual([{ id: 1, name: 'new', is_dirty: 1 }]);
    });
  });

  describe('incremental cursor (since/watermark)', () => {
    const tables: TableConfig[] = [{ name: 'assistants', strategy: 'upsert', primaryKey: 'id', columns: ['id', 'name'] }];

    it('calls fetch with since=null on the first sync', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      const fetchArgs: any[] = [];
      const remote: RemoteSource = {
        async fetch(arg) {
          fetchArgs.push(arg);
          return { rows: [{ id: 1, name: 'alice' }], cursor: 'cursor-1' };
        },
      };

      const engine = createSyncEngine({ adapter, remote, tables });
      await engine.syncTable('assistants');

      expect(fetchArgs).toEqual([{ table: 'assistants', since: null }]);
    });

    it('persists the returned cursor and passes it back as since on the next sync', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      const fetchArgs: any[] = [];
      let call = 0;
      const remote: RemoteSource = {
        async fetch(arg) {
          fetchArgs.push(arg);
          call += 1;
          return call === 1
            ? { rows: [{ id: 1, name: 'alice' }], cursor: 'cursor-1' }
            : { rows: [{ id: 2, name: 'bob' }], cursor: 'cursor-2' };
        },
      };

      const engine = createSyncEngine({ adapter, remote, tables });
      await engine.syncTable('assistants');
      await engine.syncTable('assistants');

      expect(fetchArgs).toEqual([
        { table: 'assistants', since: null },
        { table: 'assistants', since: 'cursor-1' },
      ]);
      const state = await engine.getSyncState();
      expect(state.get('assistants')?.cursor).toBe('cursor-2');
    });

    it('keeps the previous cursor when fetch omits one (RemoteSource that does not support incremental fetch)', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      let call = 0;
      const remote: RemoteSource = {
        async fetch() {
          call += 1;
          return call === 1 ? { rows: [{ id: 1, name: 'alice' }], cursor: 'cursor-1' } : [{ id: 2, name: 'bob' }];
        },
      };

      const engine = createSyncEngine({ adapter, remote, tables });
      await engine.syncTable('assistants');
      await engine.syncTable('assistants');

      const state = await engine.getSyncState();
      expect(state.get('assistants')?.cursor).toBe('cursor-1');
    });

    it('still accepts a RemoteSource that returns a plain array (pre-cursor shape)', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      const remote: RemoteSource = {
        async fetch() {
          return [{ id: 1, name: 'alice' }];
        },
      };

      const engine = createSyncEngine({ adapter, remote, tables });
      const result = await engine.syncTable('assistants');

      expect(result.count).toBe(1);
      const state = await engine.getSyncState();
      expect(state.get('assistants')?.cursor).toBeNull();
    });
  });

  describe('paginated fetch (async iterable of pages)', () => {
    const tables: TableConfig[] = [{ name: 'assistants', strategy: 'upsert', primaryKey: 'id', columns: ['id', 'name'] }];

    function pagedRemote(pages: ({ rows: Record<string, unknown>[]; cursor?: string | null } | Record<string, unknown>[])[]): RemoteSource {
      return {
        async fetch() {
          return {
            async *[Symbol.asyncIterator]() {
              for (const page of pages) yield page;
            },
          };
        },
      };
    }

    it('consumes an async-iterable fetch result page by page and accumulates the total count', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

      const remote = pagedRemote([
        { rows: [{ id: 1, name: 'alice' }, { id: 2, name: 'bob' }] },
        { rows: [{ id: 3, name: 'carol' }] },
      ]);

      const engine = createSyncEngine({ adapter, remote, tables });
      const result = await engine.syncTable('assistants');

      expect(result.count).toBe(3);
      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
        { id: 3, name: 'carol' },
      ]);
    });

    it('keeps the cursor from the last page that reports one', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

      const remote = pagedRemote([
        { rows: [{ id: 1, name: 'alice' }], cursor: 'page-1' },
        { rows: [{ id: 2, name: 'bob' }] }, // no cursor reported — must not wipe page-1
        { rows: [{ id: 3, name: 'carol' }], cursor: 'page-3' },
      ]);

      const engine = createSyncEngine({ adapter, remote, tables });
      await engine.syncTable('assistants');

      const state = await engine.getSyncState();
      expect(state.get('assistants')?.cursor).toBe('page-3');
    });

    it('applies a replace-strategy paginated fetch by accumulating all pages before the atomic swap', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (99, 'stale')");

      const remote = pagedRemote([[{ id: 1, name: 'alice' }], [{ id: 2, name: 'bob' }]]);
      const engine = createSyncEngine({
        adapter,
        remote,
        tables: [{ name: 'assistants', strategy: 'replace', columns: ['id', 'name'] }],
      });

      const result = await engine.syncTable('assistants');

      expect(result.count).toBe(2);
      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
      ]);
    });

    it('leaves a replace-strategy table fully untouched when the page iterator fails mid-iteration', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (99, 'stale')");

      const remote: RemoteSource = {
        async fetch() {
          return {
            async *[Symbol.asyncIterator]() {
              yield [{ id: 1, name: 'alice' }];
              yield [{ id: 2, name: 'bob' }];
              throw new Error('page 3 fetch failed');
            },
          };
        },
      };
      const engine = createSyncEngine({
        adapter,
        remote,
        tables: [{ name: 'assistants', strategy: 'replace', columns: ['id', 'name'] }],
      });

      await expect(engine.syncTable('assistants')).rejects.toThrow('page 3 fetch failed');

      const { rows } = await adapter.run('SELECT id, name FROM assistants');
      expect(rows).toEqual([{ id: 99, name: 'stale' }]);
    });

    it('leaves a shadow-table replace fully untouched when the page iterator fails mid-iteration', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (99, 'stale')");

      const remote: RemoteSource = {
        async fetch() {
          return {
            async *[Symbol.asyncIterator]() {
              yield [{ id: 1, name: 'alice' }];
              throw new Error('page 2 fetch failed');
            },
          };
        },
      };
      const engine = createSyncEngine({
        adapter,
        remote,
        tables: [{ name: 'assistants', strategy: 'replace', columns: ['id', 'name'], useShadowTable: true }],
      });

      await expect(engine.syncTable('assistants')).rejects.toThrow('page 2 fetch failed');

      const { rows } = await adapter.run('SELECT id, name FROM assistants');
      expect(rows).toEqual([{ id: 99, name: 'stale' }]);
      const { rows: leftoverShadow } = await adapter.run(
        `SELECT name FROM sqlite_master WHERE type='table' AND name = 'assistants__shadow'`
      );
      expect(leftoverShadow).toHaveLength(0);
    });
    it('checkpoints the cursor after each page instead of only at the end, so a mid-stream failure keeps already-applied pages reflected', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

      const remote: RemoteSource = {
        async fetch() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { rows: [{ id: 1, name: 'alice' }], cursor: 'page-1' };
              yield { rows: [{ id: 2, name: 'bob' }], cursor: 'page-2' };
              throw new Error('page 3 fetch failed');
            },
          };
        },
      };

      const engine = createSyncEngine({ adapter, remote, tables });
      await expect(engine.syncTable('assistants')).rejects.toThrow('page 3 fetch failed');

      // Pages 1 and 2 were already committed to the target table...
      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
      ]);

      // ...and the cursor must reflect that, NOT the pre-sync cursor (null),
      // otherwise the next sync re-fetches and re-applies pages 1-2.
      const state = await readAllSyncState(adapter, DEFAULT_SYNC_STATE_TABLE);
      expect(state.get('assistants')?.cursor).toBe('page-2');
      expect(state.get('assistants')?.rowCount).toBe(2);
    });

    it('checkpoints a page with zero applicable rows without rolling the cursor back on a later failure', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

      const remote: RemoteSource = {
        async fetch() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { rows: [], cursor: 'page-1-empty' };
              throw new Error('page 2 fetch failed');
            },
          };
        },
      };

      const engine = createSyncEngine({ adapter, remote, tables });
      await expect(engine.syncTable('assistants')).rejects.toThrow('page 2 fetch failed');

      const state = await readAllSyncState(adapter, DEFAULT_SYNC_STATE_TABLE);
      expect(state.get('assistants')?.cursor).toBe('page-1-empty');
      expect(state.get('assistants')?.rowCount).toBe(0);
    });

    it('happy path (no failures): final cursor and counts are identical to a single end-of-sync checkpoint', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

      const remote = pagedRemote([
        { rows: [{ id: 1, name: 'alice' }], cursor: 'page-1' },
        { rows: [{ id: 2, name: 'bob' }] }, // no cursor reported — must not wipe page-1
        { rows: [{ id: 3, name: 'carol' }], cursor: 'page-3' },
      ]);

      const engine = createSyncEngine({ adapter, remote, tables });
      const result = await engine.syncTable('assistants');

      expect(result).toEqual({
        table: 'assistants',
        strategy: 'upsert',
        count: 3,
        skipped: 0,
        upserts: 3,
        deletes: 0,
        syncedAt: expect.any(String),
      });

      const state = await readAllSyncState(adapter, DEFAULT_SYNC_STATE_TABLE);
      expect(state.get('assistants')?.cursor).toBe('page-3');
      expect(state.get('assistants')?.rowCount).toBe(3);

      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
        { id: 3, name: 'carol' },
      ]);
    });
  });

  describe('observability hooks', () => {
    const tables: TableConfig[] = [{ name: 'assistants', strategy: 'upsert', primaryKey: 'id', columns: ['id', 'name'] }];

    it('reports skipped/upserts/deletes separately in SyncTableResult', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)');
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'local-pending-edit')");

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({
          assistants: [
            { id: 1, name: 'stale-remote', deleted_at: null }, // skipped via shouldApplyRow
            { id: 2, name: 'bob', deleted_at: null }, // upsert
            { id: 3, name: 'carol', deleted_at: '2026-09-01T00:00:00Z' }, // delete (no-op, never existed)
          ],
        }),
        tables: [
          {
            name: 'assistants',
            strategy: 'upsert',
            columns: ['id', 'name', 'deleted_at'],
            primaryKey: 'id',
            deletedAtColumn: 'deleted_at',
          },
        ],
        hooks: { shouldApplyRow: (_table, row) => row.id !== 1 },
      });

      const result = await engine.syncTable('assistants');

      expect(result.skipped).toBe(1);
      expect(result.upserts).toBe(1);
      expect(result.deletes).toBe(1);
      expect(result.count).toBe(2);
    });

    it('calls onBatchComplete once per upsert batch with table/batchIndex/batchSize/durationMs', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

      const calls: { table: string; batchIndex: number; batchSize: number; durationMs: number }[] = [];
      const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, name: `name-${i + 1}` }));

      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: rows }),
        tables: [{ name: 'assistants', strategy: 'upsert', columns: ['id', 'name'], primaryKey: 'id', batchSize: 4 }],
        hooks: { onBatchComplete: info => calls.push(info) },
      });

      await engine.syncTable('assistants');

      expect(calls).toHaveLength(3);
      expect(calls.map(c => c.batchIndex)).toEqual([0, 1, 2]);
      expect(calls.map(c => c.batchSize)).toEqual([4, 4, 2]);
      calls.forEach(c => {
        expect(c.table).toBe('assistants');
        expect(typeof c.durationMs).toBe('number');
      });
    });

    it('calls onBatchComplete once for a replace-strategy table (one logical batch per table)', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

      const calls: { table: string; batchIndex: number; batchSize: number }[] = [];
      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 1, name: 'alice' }, { id: 2, name: 'bob' }] }),
        tables: [{ name: 'assistants', strategy: 'replace', columns: ['id', 'name'] }],
        hooks: { onBatchComplete: info => calls.push(info) },
      });

      await engine.syncTable('assistants');

      expect(calls).toEqual([{ table: 'assistants', batchIndex: 0, batchSize: 2 }].map(c => expect.objectContaining(c)));
    });

    it('calls onSyncStart once before and onSyncComplete once after sync() processes every table', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

      const events: string[] = [];
      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 1, name: 'alice' }] }),
        tables,
        hooks: {
          onSyncStart: () => events.push('start'),
          onSyncComplete: summary => events.push(`complete:${summary.results.length}`),
        },
      });

      await engine.sync();

      expect(events).toEqual(['start', 'complete:1']);
    });

    it('does not call onSyncStart/onSyncComplete from syncTable() directly', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

      const events: string[] = [];
      const engine = createSyncEngine({
        adapter,
        remote: makeRemote({ assistants: [{ id: 1, name: 'alice' }] }),
        tables,
        hooks: {
          onSyncStart: () => events.push('start'),
          onSyncComplete: summary => events.push(`complete:${summary.results.length}`),
        },
      });

      await engine.syncTable('assistants');

      expect(events).toEqual([]);
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
