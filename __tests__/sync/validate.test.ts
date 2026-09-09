import { assertIdentifier, validateSyncTables } from '../../src/sync/validate';

describe('assertIdentifier', () => {
  it('accepts a plain snake_case identifier', () => {
    expect(assertIdentifier('assistants', 'table')).toBe('assistants');
  });

  it('accepts an identifier starting with underscore', () => {
    expect(assertIdentifier('_nuup_sync_state', 'table')).toBe('_nuup_sync_state');
  });

  it('rejects an identifier containing spaces', () => {
    expect(() => assertIdentifier('bad name', 'table')).toThrow(/table/);
  });

  it('rejects an identifier starting with a digit', () => {
    expect(() => assertIdentifier('1bad', 'column')).toThrow(/column/);
  });

  it('rejects an identifier containing SQL metacharacters', () => {
    expect(() => assertIdentifier('a; DROP TABLE users; --', 'table')).toThrow();
  });

  it('rejects a non-string value', () => {
    expect(() => assertIdentifier(123 as unknown as string, 'table')).toThrow();
  });
});

describe('validateSyncTables', () => {
  it('throws on an empty array', () => {
    expect(() => validateSyncTables([])).toThrow(/non-empty/);
  });

  it('throws on a non-array value', () => {
    expect(() => validateSyncTables(null)).toThrow();
  });

  it('throws a descriptive error naming the table when upsert lacks primaryKey', () => {
    expect(() =>
      validateSyncTables([{ name: 'assistants', strategy: 'upsert', columns: ['id', 'name'] }])
    ).toThrow(/assistants/);
  });

  it('accepts a valid replace config without primaryKey', () => {
    const tables = validateSyncTables([{ name: 'assistants', strategy: 'replace', columns: ['id', 'name'] }]);
    expect(tables).toHaveLength(1);
    expect(tables[0].name).toBe('assistants');
  });

  it('accepts a valid upsert config with primaryKey', () => {
    const tables = validateSyncTables([
      { name: 'assistants', strategy: 'upsert', columns: ['id', 'name'], primaryKey: 'id' },
    ]);
    expect(tables).toHaveLength(1);
  });

  it('rejects an invalid table name', () => {
    expect(() =>
      validateSyncTables([{ name: 'bad name', strategy: 'replace', columns: ['id'] }])
    ).toThrow();
  });

  it('rejects an invalid strategy', () => {
    expect(() =>
      validateSyncTables([{ name: 'assistants', strategy: 'merge', columns: ['id'] }])
    ).toThrow(/strategy/);
  });
});
