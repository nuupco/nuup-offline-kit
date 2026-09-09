import type { Adapter, Migration, MigrationHooks, MigrationRunner } from '../types';
import { validateMigrations } from './validate';
import { checksumStatements } from './checksum';

export const DEFAULT_TABLE = '_nuup_migrations';

export function createMigrationRunner({
  adapter,
  migrations,
  tableName = DEFAULT_TABLE,
  hooks = {},
}: {
  adapter: Adapter;
  migrations: Migration[];
  tableName?: string;
  hooks?: MigrationHooks;
}): MigrationRunner {
  const sorted = validateMigrations(migrations);
  const { onStart, onComplete, onError } = hooks;

  async function ensureTrackingTable(): Promise<void> {
    await adapter.run(
      `CREATE TABLE IF NOT EXISTS ${tableName} (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      )`
    );
  }

  async function getAppliedVersions(): Promise<Map<number, string>> {
    const { rows } = await adapter.run(`SELECT version, checksum FROM ${tableName} ORDER BY version ASC`);
    const applied = new Map<number, string>();
    rows.forEach((row: any) => applied.set(row.version, row.checksum));
    return applied;
  }

  async function migrate(): Promise<{ appliedVersions: number[] }> {
    await ensureTrackingTable();
    const applied = await getAppliedVersions();
    const appliedVersions: number[] = [];

    for (const migration of sorted) {
      const checksum = checksumStatements(migration.statements);
      const previousChecksum = applied.get(migration.version);

      if (previousChecksum !== undefined) {
        if (previousChecksum !== checksum) {
          throw new Error(
            `migration version ${migration.version} was already applied but its statements changed ` +
              `(checksum mismatch). Never edit an applied migration — add a new one instead.`
          );
        }
        continue;
      }

      if (onStart) onStart(migration.version);

      try {
        await adapter.runInTransaction(async exec => {
          for (const statement of migration.statements) {
            if (typeof statement === 'function') {
              await statement(exec);
            } else {
              await exec(statement);
            }
          }
          await exec(`INSERT INTO ${tableName} (version, checksum) VALUES (?, ?)`, [
            migration.version,
            checksum,
          ]);
        });
        appliedVersions.push(migration.version);
        if (onComplete) onComplete(migration.version);
      } catch (error) {
        if (onError) onError(migration.version, error);
        throw error;
      }
    }

    return { appliedVersions };
  }

  return { migrate, getAppliedVersions };
}
