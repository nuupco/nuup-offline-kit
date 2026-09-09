import { createFakeExpoSqliteDb } from '../helpers/fake-expo-sqlite';
import { createExpoSqliteAdapter } from '../../src/adapters/expo-sqlite';
import { createMigrationRunner } from '../../src/migrations/runner';

function makeAdapter() {
  const database = createFakeExpoSqliteDb();
  return createExpoSqliteAdapter({ database });
}

describe('expo-sqlite adapter + createMigrationRunner integration', () => {
  it('applies a full set of migrations end-to-end', async () => {
    const adapter = makeAdapter();
    const migrations = [
      {
        version: 1,
        statements: ['CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)'],
      },
      {
        version: 2,
        statements: ["INSERT INTO users (name) VALUES ('alice')"],
      },
    ];

    const runner = createMigrationRunner({ adapter, migrations });
    const { appliedVersions } = await runner.migrate();

    expect(appliedVersions).toEqual([1, 2]);

    const { rows } = await adapter.run('SELECT * FROM users');
    expect(rows).toEqual([{ id: 1, name: 'alice' }]);
  });

  it('leaves no rows and no tracking-table entry when a migration throws mid-way', async () => {
    const adapter = makeAdapter();
    const migrations = [
      {
        version: 1,
        statements: ['CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)'],
      },
      {
        version: 2,
        statements: [
          "INSERT INTO users (name) VALUES ('bob')",
          async () => {
            throw new Error('mid-migration failure');
          },
        ],
      },
    ];

    const runner = createMigrationRunner({ adapter, migrations });

    await expect(runner.migrate()).rejects.toThrow('mid-migration failure');

    const { rows } = await adapter.run('SELECT * FROM users');
    expect(rows).toEqual([]);

    const applied = await runner.getAppliedVersions();
    expect(applied.has(2)).toBe(false);
    expect(applied.has(1)).toBe(true);
  });

  it('supports two concurrent migrate() calls on the same adapter without locking errors', async () => {
    const adapter = makeAdapter();
    const migrations = [
      {
        version: 1,
        statements: ['CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)'],
      },
      {
        version: 2,
        statements: [
          "INSERT INTO users (name) SELECT 'carol' WHERE NOT EXISTS (SELECT 1 FROM users WHERE name = 'carol')",
        ],
      },
    ];

    const runnerA = createMigrationRunner({ adapter, migrations });
    const runnerB = createMigrationRunner({ adapter, migrations });

    const [settledA, settledB] = await Promise.allSettled([runnerA.migrate(), runnerB.migrate()]);

    // The adapter's serialization guarantees no SQLite "database is locked"
    // errors occur — transactions run one at a time, never interleaved.
    // Both runners read the tracking table before either transaction starts,
    // so if they race, the second may hit a tracking-table UNIQUE constraint
    // (an application-level conflict, not a locking error) rather than
    // silently corrupting data.
    for (const settled of [settledA, settledB]) {
      if (settled.status === 'rejected') {
        expect(settled.reason.message).not.toMatch(/locked/i);
      }
    }

    // Regardless of which runner "wins", the migrations end up applied
    // exactly once and the database is left in a consistent state.
    const { rows } = await adapter.run('SELECT * FROM users');
    expect(rows).toEqual([{ id: 1, name: 'carol' }]);
  });
});
