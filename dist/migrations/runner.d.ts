import type { Adapter, Migration, MigrationHooks, MigrationRunner } from '../types';
export declare const DEFAULT_TABLE = "_nuup_migrations";
export declare function createMigrationRunner({ adapter, migrations, tableName, hooks, }: {
    adapter: Adapter;
    migrations: Migration[];
    tableName?: string;
    hooks?: MigrationHooks;
}): MigrationRunner;
//# sourceMappingURL=runner.d.ts.map