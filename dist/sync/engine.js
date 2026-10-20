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
    async function applyReplaceTable(exec, table, rows) {
        if (rows.length === 0 && !table.allowEmpty) {
            return -1; // sentinel: no-op, caller must not write sync-state
        }
        return (0, apply_1.applyReplace)(exec, table, rows);
    }
    // Each batch commits in its own short transaction instead of one
    // transaction for the whole table: on a large pull, holding a single
    // transaction open for thousands of rows blocks every other write on the
    // shared connection for the duration. 'upsert' rows are idempotent, so a
    // partial commit (earlier batches persisted, a later one rejected) is safe
    // to retry — unlike 'replace', which keeps its single transaction because
    // its DELETE+INSERT must stay all-or-nothing.
    async function syncUpsertTable(table, name, rows) {
        const batches = (0, apply_1.chunk)(rows, table.batchSize ?? apply_1.DEFAULT_BATCH_SIZE);
        let count = 0;
        for (const batch of batches) {
            count += await adapter.runInTransaction(exec => (0, apply_1.applyUpsert)(exec, table, batch));
        }
        await adapter.runInTransaction(exec => (0, state_1.recordSyncState)(exec, syncStateTable, name, count));
        return count;
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
            const result = table.strategy === 'upsert'
                ? await syncUpsertTable(table, name, rows)
                : await adapter.runInTransaction(async (exec) => {
                    const count = await applyReplaceTable(exec, table, rows);
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