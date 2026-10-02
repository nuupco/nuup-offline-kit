import { createFakeExpoSqliteDb } from '../helpers/fake-expo-sqlite';
import { createExpoSqliteAdapter } from '../../src/adapters/expo-sqlite';
import { chunk, applyReplace, applyUpsert } from '../../src/sync/apply';
import type { ReplaceTableConfig, ScopedExec, UpsertTableConfig } from '../../src/types';

function recordingExec(exec: ScopedExec): { exec: ScopedExec; sqls: string[] } {
  const sqls: string[] = [];
  const recorded = ((sql: string, params?: unknown[], options?: unknown) => {
    sqls.push(sql);
    return (exec as any)(sql, params, options);
  }) as ScopedExec;
  return { exec: recorded, sqls };
}

function makeAdapter() {
  const database = createFakeExpoSqliteDb();
  return createExpoSqliteAdapter({ database });
}

describe('chunk', () => {
  it('returns an empty array for an empty input', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it('splits into exact-multiple chunks', () => {
    expect(chunk([1, 2, 3, 4], 2)).toEqual([[1, 2], [3, 4]]);
  });

  it('splits with a remainder in the last chunk', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns a single chunk when size >= length', () => {
    expect(chunk([1, 2], 10)).toEqual([[1, 2]]);
  });
});

describe('applyReplace', () => {
  const table: ReplaceTableConfig = { name: 'assistants', strategy: 'replace', columns: ['id', 'name'] };

  it('deletes all rows then inserts fetched rows, binding values (not building identifiers from row keys)', async () => {
    const adapter = makeAdapter();
    await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
    await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'stale')");

    const count = await adapter.runInTransaction(exec =>
      applyReplace(exec, table, [
        { id: 2, name: 'alice', extra_unexpected_field: 'DROP TABLE assistants;' },
        { id: 3, name: 'bob' },
      ])
    );

    expect(count).toBe(2);
    const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
    expect(rows).toEqual([
      { id: 2, name: 'alice' },
      { id: 3, name: 'bob' },
    ]);
  });
});

describe('applyUpsert', () => {
  const table: UpsertTableConfig = {
    name: 'assistants',
    strategy: 'upsert',
    columns: ['id', 'name'],
    primaryKey: 'id',
  };

  it('inserts new rows and updates existing rows by primaryKey without duplicating', async () => {
    const adapter = makeAdapter();
    await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
    await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'old-name')");

    const count = await adapter.runInTransaction(exec =>
      applyUpsert(exec, table, [
        { id: 1, name: 'new-name' },
        { id: 2, name: 'carol' },
      ])
    );

    expect(count).toBe(2);
    const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
    expect(rows).toEqual([
      { id: 1, name: 'new-name' },
      { id: 2, name: 'carol' },
    ]);
  });

  describe('applyUpsert — deletedAtColumn', () => {
    function makeTombstoneAdapter() {
      return makeAdapter();
    }

    it('baseline: without deletedAtColumn, a row containing a deleted_at-shaped field is still upserted, and no DELETE is ever executed', async () => {
      const adapter = makeTombstoneAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)'
      );
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'old-name')");

      const tableNoDelete: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'name', 'deleted_at'],
        primaryKey: 'id',
      };

      let sqls: string[] = [];
      const count = await adapter.runInTransaction(exec => {
        const recording = recordingExec(exec);
        sqls = recording.sqls;
        return applyUpsert(recording.exec, tableNoDelete, [
          { id: 1, name: 'new-name', deleted_at: 'x' },
        ]);
      });

      expect(count).toBe(1);
      expect(sqls.some(sql => sql.startsWith('DELETE'))).toBe(false);
      const { rows } = await adapter.run('SELECT id, name, deleted_at FROM assistants');
      expect(rows).toEqual([{ id: 1, name: 'new-name', deleted_at: 'x' }]);
    });

    it('deletes an existing row when deletedAtColumn has a non-null value', async () => {
      const adapter = makeTombstoneAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)'
      );
      await adapter.run("INSERT INTO assistants (id, name) VALUES (42, 'old')");

      const tableWithDelete: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'name', 'deleted_at'],
        primaryKey: 'id',
        deletedAtColumn: 'deleted_at',
      };

      const count = await adapter.runInTransaction(exec =>
        applyUpsert(exec, tableWithDelete, [
          { id: 42, name: 'x', deleted_at: '2026-09-01T00:00:00Z' },
        ])
      );

      expect(count).toBe(1);
      const { rows } = await adapter.run('SELECT id FROM assistants');
      expect(rows).toEqual([]);
    });

    it('treats a falsy-but-non-null deletedAtColumn value as a tombstone', async () => {
      const adapter = makeTombstoneAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_flag INTEGER)'
      );
      await adapter.run("INSERT INTO assistants (id, name) VALUES (7, 'old')");

      const tableWithDelete: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'name', 'deleted_flag'],
        primaryKey: 'id',
        deletedAtColumn: 'deleted_flag',
      };

      const count = await adapter.runInTransaction(exec =>
        applyUpsert(exec, tableWithDelete, [{ id: 7, name: 'x', deleted_flag: 0 }])
      );

      expect(count).toBe(1);
      const { rows } = await adapter.run('SELECT id FROM assistants');
      expect(rows).toEqual([]);
    });

    it('upserts normally when deletedAtColumn value is null or absent', async () => {
      const adapter = makeTombstoneAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)'
      );

      const tableWithDelete: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'name', 'deleted_at'],
        primaryKey: 'id',
        deletedAtColumn: 'deleted_at',
      };

      const count = await adapter.runInTransaction(exec =>
        applyUpsert(exec, tableWithDelete, [
          { id: 1, name: 'alice', deleted_at: null },
          { id: 2, name: 'bob' },
        ])
      );

      expect(count).toBe(2);
      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
      ]);
    });

    it('interleaves deletes and upserts within the same batch, preserving array order', async () => {
      const adapter = makeTombstoneAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)'
      );
      for (let i = 1; i <= 10; i++) {
        await adapter.run(`INSERT INTO assistants (id, name) VALUES (${i}, 'orig-${i}')`);
      }

      const tableWithDelete: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'name', 'deleted_at'],
        primaryKey: 'id',
        deletedAtColumn: 'deleted_at',
        batchSize: 4,
      };

      const tombstoned = new Set([3, 6, 9]);
      const rowsPayload = Array.from({ length: 10 }, (_, i) => {
        const id = i + 1;
        return tombstoned.has(id)
          ? { id, name: `t-${id}`, deleted_at: '2026-09-01T00:00:00Z' }
          : { id, name: `new-${id}`, deleted_at: null };
      });

      let sqls: string[] = [];
      const count = await adapter.runInTransaction(exec => {
        const recording = recordingExec(exec);
        sqls = recording.sqls;
        return applyUpsert(recording.exec, tableWithDelete, rowsPayload);
      });

      expect(count).toBe(10);
      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows.map((r: any) => r.id)).toEqual([1, 2, 4, 5, 7, 8, 10]);
      rows.forEach((r: any) => expect(r.name).toBe(`new-${r.id}`));

      // SQL order follows array order: row 3 is the 3rd op and must be a DELETE, row 1 an INSERT.
      expect(sqls[0].startsWith('INSERT')).toBe(true);
      expect(sqls[2].startsWith('DELETE')).toBe(true);
    });

    it('last-wins for duplicate primary keys within the same payload', async () => {
      const adapter = makeTombstoneAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)'
      );

      const tableWithDelete: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'name', 'deleted_at'],
        primaryKey: 'id',
        deletedAtColumn: 'deleted_at',
      };

      await adapter.runInTransaction(exec =>
        applyUpsert(exec, tableWithDelete, [
          { id: 5, name: 'live', deleted_at: null },
          { id: 5, name: 'live', deleted_at: '2026-09-01T00:00:00Z' },
        ])
      );
      let result = await adapter.run('SELECT id FROM assistants WHERE id = 5');
      expect(result.rows).toEqual([]);

      await adapter.runInTransaction(exec =>
        applyUpsert(exec, tableWithDelete, [
          { id: 5, name: 'live', deleted_at: '2026-09-01T00:00:00Z' },
          { id: 5, name: 'live', deleted_at: null },
        ])
      );
      result = await adapter.run('SELECT id FROM assistants WHERE id = 5');
      expect(result.rows).toEqual([{ id: 5 }]);
    });

    it('treats primary key 0 as a valid key and deletes without throwing', async () => {
      const adapter = makeTombstoneAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)'
      );
      await adapter.run("INSERT INTO assistants (id, name) VALUES (0, 'zero')");

      const tableWithDelete: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'name', 'deleted_at'],
        primaryKey: 'id',
        deletedAtColumn: 'deleted_at',
      };

      const count = await adapter.runInTransaction(exec =>
        applyUpsert(exec, tableWithDelete, [
          { id: 0, name: 'zero', deleted_at: '2026-09-01T00:00:00Z' },
        ])
      );

      expect(count).toBe(1);
      const { rows } = await adapter.run('SELECT id FROM assistants');
      expect(rows).toEqual([]);
    });

    it('throws naming the table when a tombstoned row has a null primary key, rolling back the whole transaction', async () => {
      const adapter = makeTombstoneAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)'
      );
      await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'alice')");

      const tableWithDelete: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'name', 'deleted_at'],
        primaryKey: 'id',
        deletedAtColumn: 'deleted_at',
      };

      await expect(
        adapter.runInTransaction(exec =>
          applyUpsert(exec, tableWithDelete, [
            { id: 2, name: 'bob', deleted_at: null },
            { id: null, name: 'ghost', deleted_at: '2026-09-01T00:00:00Z' },
          ])
        )
      ).rejects.toThrow(/assistants.*missing primaryKey/is);

      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows).toEqual([{ id: 1, name: 'alice' }]);
    });

    it('throws when a tombstoned row is missing its primary key entirely', async () => {
      const adapter = makeTombstoneAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, deleted_at TEXT)'
      );

      const tableWithDelete: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'name', 'deleted_at'],
        primaryKey: 'id',
        deletedAtColumn: 'deleted_at',
      };

      await expect(
        adapter.runInTransaction(exec =>
          applyUpsert(exec, tableWithDelete, [
            { name: 'ghost', deleted_at: '2026-09-01T00:00:00Z' },
          ])
        )
      ).rejects.toThrow(/missing primaryKey/i);
    });
  });
});
