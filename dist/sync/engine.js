"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createSyncEngine = createSyncEngine;
const validate_1 = require("./validate");
const apply_1 = require("./apply");
const state_1 = require("./state");
function createSyncEngine({ adapter, remote, tables, syncStateTable = state_1.DEFAULT_SYNC_STATE_TABLE, hooks = {}, }) {
    const validatedTables = (0, validate_1.validateSyncTables)(tables);
    const byName = new Map(validatedTables.map(table => [table.name, table]));
    const { onTableStart, onTableComplete, onTableError, shouldApplyRow, onBatchComplete, onSyncStart, onSyncComplete } = hooks;
    let bootstrapped;
    function ensureBootstrap() {
        if (!bootstrapped) {
            bootstrapped = (0, state_1.ensureSyncStateTable)(adapter, syncStateTable);
        }
        return bootstrapped;
    }
    async function applyReplaceTable(exec, table, rows) {
        if (rows.length === 0 && !table.allowEmpty) {
            return null; // no-op, caller must not write sync-state
        }
        return table.useShadowTable ? (0, apply_1.applyReplaceShadow)(exec, table, rows) : (0, apply_1.applyReplace)(exec, table, rows);
    }
    // `cursor: undefined` means "this page didn't report a cursor" (either a
    // plain-array page, or an object that omitted it) — in that case the
    // previously known cursor must be kept, not wiped to null.
    function normalizeFetchPage(page) {
        if (Array.isArray(page)) {
            return { rows: page, cursor: undefined };
        }
        return { rows: page.rows, cursor: page.cursor };
    }
    // A `fetch` result is a page sequence only when it's neither a plain array
    // nor has a `rows` property (both existing shapes) and exposes an
    // (async) iterator. This keeps the two pre-existing shapes working exactly
    // as before, while additively supporting a remote that streams pages.
    function isPageSequence(result) {
        if (Array.isArray(result))
            return false;
        if (result && typeof result === 'object' && 'rows' in result)
            return false;
        return (!!result &&
            typeof result === 'object' &&
            (Symbol.asyncIterator in result || Symbol.iterator in result));
    }
    async function* iteratePages(result) {
        if (isPageSequence(result)) {
            yield* result;
        }
        else {
            yield result;
        }
    }
    // Each batch commits in its own short transaction instead of one
    // transaction for the whole table: on a large pull, holding a single
    // transaction open for thousands of rows blocks every other write on the
    // shared connection for the duration. 'upsert' rows are idempotent, so a
    // partial commit (earlier batches persisted, a later one rejected) is safe
    // to retry — unlike 'replace', which keeps its single transaction because
    // its DELETE+INSERT must stay all-or-nothing.
    //
    // `fetched` may be a single page or an async sequence of pages (S5b): each
    // page is filtered/chunked/applied incrementally as it arrives, instead of
    // buffering every row in memory first. The cursor is checkpointed to
    // sync-state after EACH page's last batch commits (in the same
    // transaction), not only once at the end: if a later page's fetch throws
    // mid-iteration, already-applied pages stay reflected in the persisted
    // cursor instead of being silently re-fetched and re-applied on the next
    // sync. The cursor used at each checkpoint is the LAST one reported so far
    // (earlier pages' cursors are superseded), keeping the previously-known
    // cursor if no page reports one.
    async function syncUpsertTable(table, name, fetched, previousCursor) {
        let cursor = previousCursor;
        let count = 0;
        let skipped = 0;
        let upserts = 0;
        let deletes = 0;
        let batchIndex = 0;
        for await (const page of iteratePages(fetched)) {
            const { rows, cursor: pageCursor } = normalizeFetchPage(page);
            if (pageCursor !== undefined)
                cursor = pageCursor;
            const applicableRows = shouldApplyRow ? rows.filter(row => shouldApplyRow(name, row)) : rows;
            skipped += rows.length - applicableRows.length;
            const batches = (0, apply_1.chunk)(applicableRows, table.batchSize ?? apply_1.DEFAULT_BATCH_SIZE);
            for (const batch of batches) {
                const start = Date.now();
                const applied = await adapter.runInTransaction(exec => (0, apply_1.applyUpsert)(exec, table, batch));
                count += applied.count;
                upserts += applied.upserts;
                deletes += applied.deletes;
                if (onBatchComplete) {
                    onBatchComplete({ table: name, batchIndex, batchSize: batch.length, durationMs: Date.now() - start });
                }
                batchIndex += 1;
            }
            // Checkpoint the cursor once this page's batches have ALL committed
            // (or immediately, in its own transaction, if the page had zero
            // applicable rows and so produced no batches) — not once per batch.
            // This is what makes an error on a LATER page leave already-applied
            // pages reflected in the persisted cursor, while keeping a single
            // (non-paginated) page's behavior identical to before: one page means
            // one checkpoint, written at the same point the old code wrote its
            // single end-of-sync checkpoint. If a batch within this page throws,
            // this line is never reached, so (as before) no watermark is written
            // for a page that didn't fully commit.
            await adapter.runInTransaction(exec => (0, state_1.recordSyncState)(exec, syncStateTable, name, count, cursor));
        }
        return { count, skipped, upserts, deletes, cursor };
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
            const previousCursor = (await (0, state_1.readSyncState)(adapter.run, syncStateTable, name))?.cursor ?? null;
            const fetched = (await remote.fetch({ table: name, since: previousCursor }));
            if (table.strategy === 'upsert') {
                const { count, skipped, upserts, deletes } = await syncUpsertTable(table, name, fetched, previousCursor);
                const state = await (0, state_1.readAllSyncState)(adapter, syncStateTable);
                const syncResult = {
                    table: name,
                    strategy: table.strategy,
                    count,
                    skipped,
                    upserts,
                    deletes,
                    syncedAt: state.get(name)?.syncedAt ?? new Date().toISOString(),
                };
                if (onTableComplete)
                    onTableComplete(syncResult);
                return syncResult;
            }
            // 'replace' (and its shadow-table variant) must apply the whole payload
            // atomically in one DELETE+INSERT (or swap) transaction, so a paginated
            // fetch is accumulated into a single row array first — there is no
            // partial/incremental apply for this strategy. `onBatchComplete` still
            // fires, but once per table (not once per internal INSERT chunk), since
            // that's the only logical "batch" boundary replace has.
            let rows = [];
            let cursor = previousCursor;
            for await (const page of iteratePages(fetched)) {
                const { rows: pageRows, cursor: pageCursor } = normalizeFetchPage(page);
                rows = rows.concat(pageRows);
                if (pageCursor !== undefined)
                    cursor = pageCursor;
            }
            const start = Date.now();
            const applied = await adapter.runInTransaction(async (exec) => {
                const result = await applyReplaceTable(exec, table, rows);
                if (result === null)
                    return null;
                await (0, state_1.recordSyncState)(exec, syncStateTable, name, result.count, cursor);
                return result;
            });
            if (applied === null) {
                // Empty payload, replace strategy without allowEmpty: no-op.
                const existing = await (0, state_1.readAllSyncState)(adapter, syncStateTable);
                const previous = existing.get(name);
                const syncResult = {
                    table: name,
                    strategy: table.strategy,
                    count: 0,
                    skipped: 0,
                    upserts: 0,
                    deletes: 0,
                    syncedAt: previous?.syncedAt ?? new Date().toISOString(),
                };
                if (onTableComplete)
                    onTableComplete(syncResult);
                return syncResult;
            }
            if (onBatchComplete) {
                onBatchComplete({ table: name, batchIndex: 0, batchSize: rows.length, durationMs: Date.now() - start });
            }
            const state = await (0, state_1.readAllSyncState)(adapter, syncStateTable);
            const syncResult = {
                table: name,
                strategy: table.strategy,
                count: applied.count,
                skipped: 0,
                upserts: applied.upserts,
                deletes: applied.deletes,
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
        if (onSyncStart)
            onSyncStart();
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
        const summary = { results, errors };
        if (onSyncComplete)
            onSyncComplete(summary);
        return summary;
    }
    async function getSyncState() {
        await ensureBootstrap();
        return (0, state_1.readAllSyncState)(adapter, syncStateTable);
    }
    return { sync, syncTable, getSyncState };
}
//# sourceMappingURL=engine.js.map