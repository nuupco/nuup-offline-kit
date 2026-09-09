import { createFakeExpoSqliteDb } from '../helpers/fake-expo-sqlite';
import { createExpoSqliteAdapter } from '../../src/adapters/expo-sqlite';
import { chunk, applyReplace, applyUpsert } from '../../src/sync/apply';
import type { ReplaceTableConfig, UpsertTableConfig } from '../../src/types';

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
});
