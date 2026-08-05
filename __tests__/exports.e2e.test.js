describe('package.json exports map (end-to-end resolution)', () => {
  it('resolves the root subpath via the package name', () => {
    const kit = require('@nuup/offline-kit');

    expect(typeof kit.createMigrationRunner).toBe('function');
    expect(typeof kit.validateMigrations).toBe('function');
    expect(typeof kit.createExpoSqliteAdapter).toBe('function');
  });

  it('resolves the ./migrations subpath via the package name', () => {
    const migrations = require('@nuup/offline-kit/migrations');

    expect(typeof migrations.createMigrationRunner).toBe('function');
  });

  it('resolves the ./adapters/expo-sqlite subpath via the package name', () => {
    const adapter = require('@nuup/offline-kit/adapters/expo-sqlite');

    expect(typeof adapter.createExpoSqliteAdapter).toBe('function');
  });

  it('resolves ./package.json via the exports fallback', () => {
    const pkg = require('@nuup/offline-kit/package.json');

    expect(pkg.name).toBe('@nuup/offline-kit');
  });
});
