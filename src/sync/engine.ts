import type {
  ReplaceTableConfig,
  ScopedExec,
  SyncEngine,
  SyncEngineConfig,
  SyncState,
  SyncSummary,
  SyncTableResult,
  TableConfig,
  UpsertTableConfig,
} from '../types';
import { validateSyncTables } from './validate';
import { applyReplace, applyReplaceShadow, applyUpsert, chunk, DEFAULT_BATCH_SIZE, type ApplyResult } from './apply';
import { DEFAULT_SYNC_STATE_TABLE, ensureSyncStateTable, readAllSyncState, readSyncState, recordSyncState } from './state';

type Row = Record<string, unknown>;
type FetchPage = Row[] | { rows: Row[]; cursor?: string | null };
type FetchResult = FetchPage | AsyncIterable<FetchPage>;

export function createSyncEngine({
  adapter,
  remote,
  tables,
  syncStateTable = DEFAULT_SYNC_STATE_TABLE,
  hooks = {},
}: SyncEngineConfig): SyncEngine {
  const validatedTables = validateSyncTables(tables);
  const byName = new Map<string, TableConfig>(validatedTables.map(table => [table.name, table]));
  const { onTableStart, onTableComplete, onTableError, shouldApplyRow, onBatchComplete, onSyncStart, onSyncComplete } =
    hooks;

  let bootstrapped: Promise<void> | undefined;
  function ensureBootstrap(): Promise<void> {
    if (!bootstrapped) {
      bootstrapped = ensureSyncStateTable(adapter, syncStateTable);
    }
    return bootstrapped;
  }

  async function applyReplaceTable(
    exec: ScopedExec,
    table: ReplaceTableConfig,
    rows: Row[]
  ): Promise<ApplyResult | null> {
    if (rows.length === 0 && !table.allowEmpty) {
      return null; // no-op, caller must not write sync-state
    }
    return table.useShadowTable ? applyReplaceShadow(exec, table, rows) : applyReplace(exec, table, rows);
  }

  // `cursor: undefined` means "this page didn't report a cursor" (either a
  // plain-array page, or an object that omitted it) — in that case the
  // previously known cursor must be kept, not wiped to null.
  function normalizeFetchPage(page: FetchPage): { rows: Row[]; cursor: string | null | undefined } {
    if (Array.isArray(page)) {
      return { rows: page, cursor: undefined };
    }
    return { rows: page.rows, cursor: page.cursor };
  }

  // A `fetch` result is a page sequence only when it's neither a plain array
  // nor has a `rows` property (both existing shapes) and exposes an
  // (async) iterator. This keeps the two pre-existing shapes working exactly
  // as before, while additively supporting a remote that streams pages.
  function isPageSequence(result: FetchResult): result is AsyncIterable<FetchPage> {
    if (Array.isArray(result)) return false;
    if (result && typeof result === 'object' && 'rows' in (result as object)) return false;
    return (
      !!result &&
      typeof result === 'object' &&
      (Symbol.asyncIterator in (result as object) || Symbol.iterator in (result as object))
    );
  }

  async function* iteratePages(result: FetchResult): AsyncGenerator<FetchPage> {
    if (isPageSequence(result)) {
      yield* result;
    } else {
      yield result as FetchPage;
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
  // buffering every row in memory first. The final sync-state write uses the
  // cursor from the LAST page that reported one (earlier pages' cursors are
  // superseded), and keeps the previously-known cursor if no page reports one.
  async function syncUpsertTable(
    table: UpsertTableConfig,
    name: string,
    fetched: FetchResult,
    previousCursor: string | null
  ): Promise<{ count: number; skipped: number; upserts: number; deletes: number; cursor: string | null }> {
    let cursor = previousCursor;
    let count = 0;
    let skipped = 0;
    let upserts = 0;
    let deletes = 0;
    let batchIndex = 0;

    for await (const page of iteratePages(fetched)) {
      const { rows, cursor: pageCursor } = normalizeFetchPage(page);
      if (pageCursor !== undefined) cursor = pageCursor;

      const applicableRows = shouldApplyRow ? rows.filter(row => shouldApplyRow(name, row)) : rows;
      skipped += rows.length - applicableRows.length;

      const batches = chunk(applicableRows, table.batchSize ?? DEFAULT_BATCH_SIZE);
      for (const batch of batches) {
        const start = Date.now();
        const applied = await adapter.runInTransaction(exec => applyUpsert(exec, table, batch));
        count += applied.count;
        upserts += applied.upserts;
        deletes += applied.deletes;
        if (onBatchComplete) {
          onBatchComplete({ table: name, batchIndex, batchSize: batch.length, durationMs: Date.now() - start });
        }
        batchIndex += 1;
      }
    }

    await adapter.runInTransaction(exec => recordSyncState(exec, syncStateTable, name, count, cursor));
    return { count, skipped, upserts, deletes, cursor };
  }

  async function syncTable(name: string): Promise<SyncTableResult> {
    const table = byName.get(name);
    if (!table) {
      throw new Error(`syncTable: unknown table "${name}" — not present in the configured tables`);
    }

    await ensureBootstrap();

    if (onTableStart) onTableStart(name);

    try {
      const previousCursor = (await readSyncState(adapter.run, syncStateTable, name))?.cursor ?? null;
      const fetched = (await remote.fetch({ table: name, since: previousCursor })) as FetchResult;

      if (table.strategy === 'upsert') {
        const { count, skipped, upserts, deletes } = await syncUpsertTable(table, name, fetched, previousCursor);
        const state = await readAllSyncState(adapter, syncStateTable);
        const syncResult: SyncTableResult = {
          table: name,
          strategy: table.strategy,
          count,
          skipped,
          upserts,
          deletes,
          syncedAt: state.get(name)?.syncedAt ?? new Date().toISOString(),
        };
        if (onTableComplete) onTableComplete(syncResult);
        return syncResult;
      }

      // 'replace' (and its shadow-table variant) must apply the whole payload
      // atomically in one DELETE+INSERT (or swap) transaction, so a paginated
      // fetch is accumulated into a single row array first — there is no
      // partial/incremental apply for this strategy. `onBatchComplete` still
      // fires, but once per table (not once per internal INSERT chunk), since
      // that's the only logical "batch" boundary replace has.
      let rows: Row[] = [];
      let cursor = previousCursor;
      for await (const page of iteratePages(fetched)) {
        const { rows: pageRows, cursor: pageCursor } = normalizeFetchPage(page);
        rows = rows.concat(pageRows);
        if (pageCursor !== undefined) cursor = pageCursor;
      }

      const start = Date.now();
      const applied = await adapter.runInTransaction(async exec => {
        const result = await applyReplaceTable(exec, table as ReplaceTableConfig, rows);
        if (result === null) return null;
        await recordSyncState(exec, syncStateTable, name, result.count, cursor);
        return result;
      });

      if (applied === null) {
        // Empty payload, replace strategy without allowEmpty: no-op.
        const existing = await readAllSyncState(adapter, syncStateTable);
        const previous = existing.get(name);
        const syncResult: SyncTableResult = {
          table: name,
          strategy: table.strategy,
          count: 0,
          skipped: 0,
          upserts: 0,
          deletes: 0,
          syncedAt: previous?.syncedAt ?? new Date().toISOString(),
        };
        if (onTableComplete) onTableComplete(syncResult);
        return syncResult;
      }

      if (onBatchComplete) {
        onBatchComplete({ table: name, batchIndex: 0, batchSize: rows.length, durationMs: Date.now() - start });
      }

      const state = await readAllSyncState(adapter, syncStateTable);
      const syncResult: SyncTableResult = {
        table: name,
        strategy: table.strategy,
        count: applied.count,
        skipped: 0,
        upserts: applied.upserts,
        deletes: applied.deletes,
        syncedAt: state.get(name)?.syncedAt ?? new Date().toISOString(),
      };
      if (onTableComplete) onTableComplete(syncResult);
      return syncResult;
    } catch (error) {
      if (onTableError) onTableError(name, error);
      throw error;
    }
  }

  async function sync(): Promise<SyncSummary> {
    if (onSyncStart) onSyncStart();

    const results: SyncTableResult[] = [];
    const errors: { table: string; error: unknown }[] = [];

    for (const table of validatedTables) {
      try {
        const result = await syncTable(table.name);
        results.push(result);
      } catch (error) {
        errors.push({ table: table.name, error });
      }
    }

    const summary: SyncSummary = { results, errors };
    if (onSyncComplete) onSyncComplete(summary);
    return summary;
  }

  async function getSyncState(): Promise<Map<string, SyncState>> {
    await ensureBootstrap();
    return readAllSyncState(adapter, syncStateTable);
  }

  return { sync, syncTable, getSyncState };
}
