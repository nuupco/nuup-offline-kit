"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_TABLE = void 0;
exports.createMigrationRunner = createMigrationRunner;
const validate_1 = require("./validate");
const checksum_1 = require("./checksum");
exports.DEFAULT_TABLE = '_nuup_migrations';
function createMigrationRunner({ adapter, migrations, tableName = exports.DEFAULT_TABLE, hooks = {}, }) {
    const sorted = (0, validate_1.validateMigrations)(migrations);
    const { onStart, onComplete, onError } = hooks;
    async function ensureTrackingTable() {
        await adapter.run(`CREATE TABLE IF NOT EXISTS ${tableName} (
        version INTEGER PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TEXT DEFAULT (datetime('now'))
      )`);
    }
    async function getAppliedVersions() {
        const { rows } = await adapter.run(`SELECT version, checksum FROM ${tableName} ORDER BY version ASC`);
        const applied = new Map();
        rows.forEach((row) => applied.set(row.version, row.checksum));
        return applied;
    }
    async function migrate() {
        await ensureTrackingTable();
        const applied = await getAppliedVersions();
        const appliedVersions = [];
        for (const migration of sorted) {
            const checksum = (0, checksum_1.checksumStatements)(migration.statements);
            const previousChecksum = applied.get(migration.version);
            if (previousChecksum !== undefined) {
                if (previousChecksum !== checksum) {
                    throw new Error(`migration version ${migration.version} was already applied but its statements changed ` +
                        `(checksum mismatch). Never edit an applied migration — add a new one instead.`);
                }
                continue;
            }
            if (onStart)
                onStart(migration.version);
            try {
                await adapter.runInTransaction(async (exec) => {
                    for (const statement of migration.statements) {
                        if (typeof statement === 'function') {
                            await statement(exec);
                        }
                        else {
                            await exec(statement);
                        }
                    }
                    await exec(`INSERT INTO ${tableName} (version, checksum) VALUES (?, ?)`, [
                        migration.version,
                        checksum,
                    ]);
                });
                appliedVersions.push(migration.version);
                if (onComplete)
                    onComplete(migration.version);
            }
            catch (error) {
                if (onError)
                    onError(migration.version, error);
                throw error;
            }
        }
        return { appliedVersions };
    }
    return { migrate, getAppliedVersions };
}
//# sourceMappingURL=runner.js.map