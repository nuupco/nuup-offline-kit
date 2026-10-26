import { createFakeExpoSqliteDb } from '../helpers/fake-expo-sqlite';
import { createExpoSqliteAdapter } from '../../src/adapters/expo-sqlite';
import { chunk, applyReplace, applyReplaceShadow, applyUpsert } from '../../src/sync/apply';
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

    const result = await adapter.runInTransaction(exec =>
      applyReplace(exec, table, [
        { id: 2, name: 'alice', extra_unexpected_field: 'DROP TABLE assistants;' },
        { id: 3, name: 'bob' },
      ])
    );

    expect(result.count).toBe(2);
    const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
    expect(rows).toEqual([
      { id: 2, name: 'alice' },
      { id: 3, name: 'bob' },
    ]);
  });

  it('sends one multi-row INSERT per batch instead of one INSERT per row', async () => {
    const adapter = makeAdapter();
    await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

    let sqls: string[] = [];
    const result = await adapter.runInTransaction(exec => {
      const recording = recordingExec(exec);
      sqls = recording.sqls;
      return applyReplace(recording.exec, table, [
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
        { id: 3, name: 'carol' },
      ]);
    });

    expect(result).toEqual({ count: 3, upserts: 3, deletes: 0 });
    const insertSqls = sqls.filter(sql => sql.startsWith('INSERT'));
    expect(insertSqls).toHaveLength(1);
    expect(insertSqls[0]).toBe(
      'INSERT INTO assistants (id, name) VALUES (?, ?), (?, ?), (?, ?)'
    );
    const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
    expect(rows).toEqual([
      { id: 1, name: 'alice' },
      { id: 2, name: 'bob' },
      { id: 3, name: 'carol' },
    ]);
  });

  it('sends one multi-row INSERT per batchSize-bounded batch (two batches for a payload over batchSize)', async () => {
    const adapter = makeAdapter();
    await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');
    const batchedTable: ReplaceTableConfig = { ...table, batchSize: 2 };

    let sqls: string[] = [];
    await adapter.runInTransaction(exec => {
      const recording = recordingExec(exec);
      sqls = recording.sqls;
      return applyReplace(recording.exec, batchedTable, [
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
        { id: 3, name: 'carol' },
      ]);
    });

    const insertSqls = sqls.filter(sql => sql.startsWith('INSERT'));
    expect(insertSqls).toHaveLength(2);
    const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
    expect(rows).toHaveLength(3);
  });
});

describe('applyReplaceShadow', () => {
  const table: ReplaceTableConfig = { name: 'assistants', strategy: 'replace', columns: ['id', 'name'] };

  it('swaps in the new rows and preserves the original schema (PRIMARY KEY still enforced)', async () => {
    const adapter = makeAdapter();
    await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'stale')");

    const result = await adapter.runInTransaction(exec =>
      applyReplaceShadow(exec, table, [
        { id: 2, name: 'alice' },
        { id: 3, name: 'bob' },
      ])
    );

    expect(result.count).toBe(2);
    const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
    expect(rows).toEqual([
      { id: 2, name: 'alice' },
      { id: 3, name: 'bob' },
    ]);

    // PRIMARY KEY constraint from the original schema must survive the swap.
    await expect(adapter.run('INSERT INTO assistants (id, name) VALUES (2, \'dup\')')).rejects.toThrow();
    // NOT NULL constraint from the original schema must survive the swap.
    await expect(adapter.run('INSERT INTO assistants (id, name) VALUES (4, NULL)')).rejects.toThrow();
  });

  it('leaves the original table fully intact when a write fails mid-swap (no half-applied state)', async () => {
    const adapter = makeAdapter();
    await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'stale')");

    await expect(
      adapter.runInTransaction(exec =>
        applyReplaceShadow(exec, table, [
          { id: 2, name: 'alice' },
          { id: 3, name: null }, // violates NOT NULL — must abort the whole swap
        ])
      )
    ).rejects.toThrow();

    const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
    expect(rows).toEqual([{ id: 1, name: 'stale' }]);
    const { rows: leftoverShadow } = await adapter.run(
      `SELECT name FROM sqlite_master WHERE type='table' AND name = 'assistants__shadow'`
    );
    expect(leftoverShadow).toHaveLength(0);
  });

  it('recovers cleanly from a leftover shadow table left by a previous crashed run', async () => {
    const adapter = makeAdapter();
    await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    await adapter.run('CREATE TABLE assistants__shadow (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    await adapter.run("INSERT INTO assistants__shadow (id, name) VALUES (99, 'orphaned')");

    const result = await adapter.runInTransaction(exec => applyReplaceShadow(exec, table, [{ id: 1, name: 'alice' }]));

    expect(result.count).toBe(1);
    const { rows } = await adapter.run('SELECT id, name FROM assistants');
    expect(rows).toEqual([{ id: 1, name: 'alice' }]);
  });

  it('throws a descriptive error when the target table does not exist yet', async () => {
    const adapter = makeAdapter();
    await expect(adapter.runInTransaction(exec => applyReplaceShadow(exec, table, []))).rejects.toThrow(
      /does not exist|assistants/
    );
  });

  it('recreates a secondary index and a trigger after the swap', async () => {
    const adapter = makeAdapter();
    await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
    await adapter.run('CREATE INDEX idx_assistants_name ON assistants (name)');
    await adapter.run('CREATE TABLE assistants_log (id INTEGER PRIMARY KEY, message TEXT)');
    await adapter.run(`
      CREATE TRIGGER trg_assistants_ai AFTER INSERT ON assistants
      BEGIN
        INSERT INTO assistants_log (message) VALUES ('inserted: ' || NEW.name);
      END
    `);
    await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'stale')");

    const result = await adapter.runInTransaction(exec =>
      applyReplaceShadow(exec, table, [
        { id: 2, name: 'alice' },
        { id: 3, name: 'bob' },
      ])
    );

    expect(result.count).toBe(2);

    const { rows: indexRows } = await adapter.run(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'assistants' AND name = 'idx_assistants_name'`
    );
    expect(indexRows).toHaveLength(1);

    const { rows: triggerRows } = await adapter.run(
      `SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'assistants' AND name = 'trg_assistants_ai'`
    );
    expect(triggerRows).toHaveLength(1);

    // The trigger must actually fire against the post-swap table (not just exist in sqlite_master):
    // rows inserted into the shadow table during the swap predate trigger recreation, so only a
    // post-swap insert against the now-renamed table proves the trigger is live.
    await adapter.run("INSERT INTO assistants (id, name) VALUES (4, 'carol')");
    const { rows: logRows } = await adapter.run('SELECT message FROM assistants_log ORDER BY id');
    expect(logRows).toEqual([{ message: 'inserted: stale' }, { message: 'inserted: carol' }]);
  });

  it('does not try to recreate autogenerated sqlite_autoindex_* indexes (no "index already exists" error)', async () => {
    const adapter = makeAdapter();
    // UNIQUE on a non-rowid-alias column creates an autoindex backing the constraint.
    await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE)');
    await adapter.run("INSERT INTO assistants (id, name) VALUES (1, 'stale')");

    const result = await adapter.runInTransaction(exec =>
      applyReplaceShadow(exec, table, [
        { id: 2, name: 'alice' },
        { id: 3, name: 'bob' },
      ])
    );

    expect(result.count).toBe(2);
    // UNIQUE constraint from the original schema must still be enforced (autoindex survived via CREATE TABLE).
    await expect(adapter.run("INSERT INTO assistants (id, name) VALUES (4, 'alice')")).rejects.toThrow();
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

    const result = await adapter.runInTransaction(exec =>
      applyUpsert(exec, table, [
        { id: 1, name: 'new-name' },
        { id: 2, name: 'carol' },
      ])
    );

    expect(result.count).toBe(2);
    expect(result.upserts).toBe(2);
    expect(result.deletes).toBe(0);
    const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
    expect(rows).toEqual([
      { id: 1, name: 'new-name' },
      { id: 2, name: 'carol' },
    ]);
  });

  it('sends one multi-row INSERT for a run of consecutive non-tombstoned rows instead of one per row', async () => {
    const adapter = makeAdapter();
    await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT)');

    let sqls: string[] = [];
    await adapter.runInTransaction(exec => {
      const recording = recordingExec(exec);
      sqls = recording.sqls;
      return applyUpsert(recording.exec, table, [
        { id: 1, name: 'alice' },
        { id: 2, name: 'bob' },
        { id: 3, name: 'carol' },
      ]);
    });

    const insertSqls = sqls.filter(sql => sql.startsWith('INSERT'));
    expect(insertSqls).toHaveLength(1);
    expect(insertSqls[0]).toContain('VALUES (?, ?), (?, ?), (?, ?)');
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
      const result = await adapter.runInTransaction(exec => {
        const recording = recordingExec(exec);
        sqls = recording.sqls;
        return applyUpsert(recording.exec, tableNoDelete, [
          { id: 1, name: 'new-name', deleted_at: 'x' },
        ]);
      });

      expect(result.count).toBe(1);
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

      const result = await adapter.runInTransaction(exec =>
        applyUpsert(exec, tableWithDelete, [
          { id: 42, name: 'x', deleted_at: '2026-09-01T00:00:00Z' },
        ])
      );

      expect(result.count).toBe(1);
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

      const result = await adapter.runInTransaction(exec =>
        applyUpsert(exec, tableWithDelete, [{ id: 7, name: 'x', deleted_flag: 0 }])
      );

      expect(result.count).toBe(1);
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

      const result = await adapter.runInTransaction(exec =>
        applyUpsert(exec, tableWithDelete, [
          { id: 1, name: 'alice', deleted_at: null },
          { id: 2, name: 'bob' },
        ])
      );

      expect(result.count).toBe(2);
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
      const result = await adapter.runInTransaction(exec => {
        const recording = recordingExec(exec);
        sqls = recording.sqls;
        return applyUpsert(recording.exec, tableWithDelete, rowsPayload);
      });

      expect(result.count).toBe(10);
      expect(result.upserts).toBe(7);
      expect(result.deletes).toBe(3);
      const { rows } = await adapter.run('SELECT id, name FROM assistants ORDER BY id');
      expect(rows.map((r: any) => r.id)).toEqual([1, 2, 4, 5, 7, 8, 10]);
      rows.forEach((r: any) => expect(r.name).toBe(`new-${r.id}`));

      // Consecutive non-tombstoned rows (1, 2) are grouped into one multi-row INSERT, then the
      // tombstoned row (3) is its own DELETE, then row 4 starts a new run/INSERT — order preserved.
      expect(sqls[0].startsWith('INSERT')).toBe(true);
      expect(sqls[1].startsWith('DELETE')).toBe(true);
      expect(sqls[2].startsWith('INSERT')).toBe(true);
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

      const result = await adapter.runInTransaction(exec =>
        applyUpsert(exec, tableWithDelete, [
          { id: 0, name: 'zero', deleted_at: '2026-09-01T00:00:00Z' },
        ])
      );

      expect(result.count).toBe(1);
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

  describe('applyUpsert — preserveColumns', () => {
    it('sets preserveColumns to their given value on INSERT, but excludes them from the UPDATE SET clause', async () => {
      const adapter = makeAdapter();
      await adapter.run(
        'CREATE TABLE assistants (id INTEGER PRIMARY KEY, name TEXT, is_dirty INTEGER)'
      );
      await adapter.run("INSERT INTO assistants (id, name, is_dirty) VALUES (1, 'old-name', 1)");

      const tableWithPreserve: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'name', 'is_dirty'],
        primaryKey: 'id',
        preserveColumns: ['is_dirty'],
      };

      let sqls: string[] = [];
      await adapter.runInTransaction(exec => {
        const recording = recordingExec(exec);
        sqls = recording.sqls;
        return applyUpsert(recording.exec, tableWithPreserve, [
          { id: 1, name: 'new-name', is_dirty: 0 }, // existing row: is_dirty must be preserved (stays 1)
          { id: 2, name: 'bob', is_dirty: 0 }, // new row: is_dirty gets its given default (0)
        ]);
      });

      const insertSql = sqls.find(sql => sql.startsWith('INSERT'));
      expect(insertSql).toContain('is_dirty');
      expect(insertSql).not.toMatch(/is_dirty = excluded\.is_dirty/);
      expect(insertSql).toContain('name = excluded.name');

      const { rows } = await adapter.run('SELECT id, name, is_dirty FROM assistants ORDER BY id');
      expect(rows).toEqual([
        { id: 1, name: 'new-name', is_dirty: 1 }, // preserved, not overwritten
        { id: 2, name: 'bob', is_dirty: 0 }, // seeded on insert
      ]);
    });

    it('falls back to DO NOTHING when preserveColumns leaves no column left to update', async () => {
      const adapter = makeAdapter();
      await adapter.run('CREATE TABLE assistants (id INTEGER PRIMARY KEY, is_dirty INTEGER)');
      await adapter.run('INSERT INTO assistants (id, is_dirty) VALUES (1, 1)');

      const tableWithPreserve: UpsertTableConfig = {
        name: 'assistants',
        strategy: 'upsert',
        columns: ['id', 'is_dirty'],
        primaryKey: 'id',
        preserveColumns: ['is_dirty'],
      };

      let sqls: string[] = [];
      await adapter.runInTransaction(exec => {
        const recording = recordingExec(exec);
        sqls = recording.sqls;
        return applyUpsert(recording.exec, tableWithPreserve, [{ id: 1, is_dirty: 0 }]);
      });

      const insertSql = sqls.find(sql => sql.startsWith('INSERT'));
      expect(insertSql).toMatch(/DO NOTHING/);

      const { rows } = await adapter.run('SELECT id, is_dirty FROM assistants');
      expect(rows).toEqual([{ id: 1, is_dirty: 1 }]);
    });
  });
});
