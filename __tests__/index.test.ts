import * as kit from '../src/index';

describe('root barrel (src/index.ts)', () => {
  it('exposes both the migrations API and createExpoSqliteAdapter', () => {
    expect(typeof kit.createMigrationRunner).toBe('function');
    expect(typeof kit.validateMigrations).toBe('function');
    expect(typeof kit.createExpoSqliteAdapter).toBe('function');
  });
});
