describe('root barrel (src/index.js)', () => {
  it('exposes both the migrations API and createExpoSqliteAdapter', () => {
    const kit = require('../src/index.js');

    expect(typeof kit.createMigrationRunner).toBe('function');
    expect(typeof kit.validateMigrations).toBe('function');
    expect(typeof kit.createExpoSqliteAdapter).toBe('function');
  });
});
