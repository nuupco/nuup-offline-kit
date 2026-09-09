"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSyncEngine = createSyncEngine;
const validate_1 = require("./validate");
const apply_1 = require("./apply");
const state_1 = require("./state");
function createSyncEngine({ adapter, remote, tables, syncStateTable = state_1.DEFAULT_SYNC_STATE_TABLE, hooks = {}, }) {
    const validatedTables = (0, validate_1.validateSyncTables)(tables);
    const byName = new Map(validatedTables.map(table => [table.name, table]));
    const { onTableStart, onTableComplete, onTableError } = hooks;
    let bootstrapped;
    function ensureBootstrap() {
        if (!bootstrapped) {
            bootstrapped = (0, state_1.ensureSyncStateTable)(adapter, syncStateTable);
        }
        return bootstrapped;
    }
    async function applyTable(exec, table, rows) {
        if (table.strategy === 'upsert') {
            return (0, apply_1.applyUpsert)(exec, table, rows);
        }
        const replaceTable = table;
        if (rows.length === 0 && !replaceTable.allowEmpty) {
            return -1; // sentinel: no-op, caller must not write sync-state
        }
        return (0, apply_1.applyReplace)(exec, replaceTable, rows);
    }
    async function syncTable(name) {
        const table = byName.get(name);
        if (!table) {
            throw new Error(`syncTable: unknown table "${name}" — not present in the configured tables`);
        }
        await ensureBootstrap();
        if (onTableStart)
            onTableStart(name);
        try {
            const rows = await remote.fetch({ table: name });
            const result = await adapter.runInTransaction(async (exec) => {
                const count = await applyTable(exec, table, rows);
                if (count === -1) {
                    return null;
                }
                await (0, state_1.recordSyncState)(exec, syncStateTable, name, count);
                return count;
            });
            if (result === null) {
                // Empty payload, replace strategy without allowEmpty: no-op.
                const existing = await (0, state_1.readAllSyncState)(adapter, syncStateTable);
                const previous = existing.get(name);
                const syncResult = {
                    table: name,
                    strategy: table.strategy,
                    count: 0,
                    syncedAt: previous?.syncedAt ?? new Date().toISOString(),
                };
                if (onTableComplete)
                    onTableComplete(syncResult);
                return syncResult;
            }
            const state = await (0, state_1.readAllSyncState)(adapter, syncStateTable);
            const syncResult = {
                table: name,
                strategy: table.strategy,
                count: result,
                syncedAt: state.get(name)?.syncedAt ?? new Date().toISOString(),
            };
            if (onTableComplete)
                onTableComplete(syncResult);
            return syncResult;
        }
        catch (error) {
            if (onTableError)
                onTableError(name, error);
            throw error;
        }
    }
    async function sync() {
        const results = [];
        const errors = [];
        for (const table of validatedTables) {
            try {
                const result = await syncTable(table.name);
                results.push(result);
            }
            catch (error) {
                errors.push({ table: table.name, error });
            }
        }
        return { results, errors };
    }
    async function getSyncState() {
        await ensureBootstrap();
        return (0, state_1.readAllSyncState)(adapter, syncStateTable);
    }
    return { sync, syncTable, getSyncState };
}
//# sourceMappingURL=engine.js.map