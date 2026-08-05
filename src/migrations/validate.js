function validateMigrations(migrations) {
  if (!Array.isArray(migrations) || migrations.length === 0) {
    throw new Error('migrations must be a non-empty array');
  }

  const sorted = [...migrations].sort((a, b) => a.version - b.version);

  sorted.forEach((migration, index) => {
    const expectedVersion = index + 1;
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error(`migration at index ${index} has an invalid version: ${migration.version}`);
    }
    if (migration.version !== expectedVersion) {
      throw new Error(
        `migrations must be sequential starting at 1 with no gaps or duplicates. ` +
          `expected version ${expectedVersion}, found ${migration.version}`
      );
    }
    if (!Array.isArray(migration.statements) || migration.statements.length === 0) {
      throw new Error(`migration version ${migration.version} must define a non-empty "statements" array`);
    }
  });

  return sorted;
}

module.exports = { validateMigrations };
