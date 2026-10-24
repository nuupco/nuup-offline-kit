export type SqlParam = string | number | null | Uint8Array;
export interface ExecOptions {
    read?: boolean;
}
export interface ExecResult<R = Record<string, unknown>> {
    rows: R[];
    rowsAffected: number;
    insertId: number | undefined;
}
export type Exec = <R = Record<string, unknown>>(sql: string, params?: SqlParam[], options?: ExecOptions) => Promise<ExecResult<R>>;
/**
 * Frozen, transaction-scoped handle. Structural guard: passed by argument,
 * never resolved from ambient/thread-local state.
 */
export interface ScopedExec extends Exec {
    readonly run: Exec;
    /** Always rejects: nested transactions unsupported. */
    readonly runInTransaction: (fn: (exec: ScopedExec) => unknown) => Promise<never>;
}
export interface Adapter {
    run: Exec;
    runInTransaction<T>(fn: (exec: ScopedExec) => Promise<T> | T): Promise<T>;
}
export type MigrationStatement = string | ((exec: ScopedExec) => Promise<void> | void);
export interface Migration {
    version: number;
    statements: MigrationStatement[];
}
export interface MigrationHooks {
    onStart?(version: number): void;
    onComplete?(version: number): void;
    onError?(version: number, error: unknown): void;
}
export interface MigrationRunner {
    migrate(): Promise<{
        appliedVersions: number[];
    }>;
    getAppliedVersions(): Promise<Map<number, string>>;
}
export interface ExpoSqliteDatabase {
    getAllAsync<R = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<R[]>;
    runAsync(sql: string, params?: SqlParam[]): Promise<{
        changes: number;
        lastInsertRowId: number;
    }>;
    execAsync(sql: string): Promise<void>;
}
export interface ExpoSqliteModule {
    openDatabaseSync(name: string): ExpoSqliteDatabase;
}
interface BaseTableConfig {
    name: string;
    columns: string[];
    batchSize?: number;
}
export interface ReplaceTableConfig extends BaseTableConfig {
    strategy: 'replace';
    primaryKey?: string;
    allowEmpty?: boolean;
    /**
     * When true, replace via a shadow-table swap (build `${name}__shadow` with
     * the table's existing schema, insert into it, then atomically swap it in)
     * instead of DELETE+INSERT. Avoids leaving the table empty if interrupted
     * mid-sync. The table must already exist (created by a migration). Default
     * false, to keep existing DELETE+INSERT behavior unless opted in.
     */
    useShadowTable?: boolean;
}
export interface UpsertTableConfig extends BaseTableConfig {
    strategy: 'upsert';
    primaryKey: string;
    /**
     * Optional tombstone marker. When a fetched row has any non-null value in this
     * column (including '', 0, false), the local row with that primaryKey is
     * DELETEd instead of upserted. Must be listed in `columns`. Upsert-only.
     */
    deletedAtColumn?: string;
    /**
     * Columns that should receive their normal value on INSERT (new row) but be
     * excluded from the `SET` clause of `ON CONFLICT ... DO UPDATE` (existing
     * row keeps its current local value). Useful for local bookkeeping columns
     * (e.g. a dirty flag or local-edit timestamp) that should only ever be
     * seeded once, never overwritten by a later sync. Must each be listed in
     * `columns`. Upsert-only.
     */
    preserveColumns?: string[];
}
export type TableConfig = ReplaceTableConfig | UpsertTableConfig;
export interface RemoteSource {
    /**
     * `since` is the cursor persisted from this table's previous sync (`null`
     * on the first sync, or whenever no cursor was recorded). A RemoteSource
     * that doesn't support incremental fetching can ignore it and always
     * return the full set. `cursor` in the result, when present, is persisted
     * to `_nuup_sync_state` and passed back as `since` on the next sync.
     *
     * `fetch` may also return an async iterable of pages instead of a single
     * `rows`/`cursor` shape (a single page). This is additive: an existing
     * `fetch` that returns a plain array or `{rows, cursor}` keeps working
     * unchanged; only a result that is neither an array nor has a `rows`
     * property, and exposes `Symbol.asyncIterator`/`Symbol.iterator`, is
     * treated as a page sequence.
     */
    fetch(arg: {
        table: string;
        since?: string | null;
    }): Promise<Record<string, unknown>[] | {
        rows: Record<string, unknown>[];
        cursor?: string | null;
    } | AsyncIterable<Record<string, unknown>[] | {
        rows: Record<string, unknown>[];
        cursor?: string | null;
    }>>;
}
export interface SyncTableResult {
    table: string;
    strategy: TableConfig['strategy'];
    /** Total rows applied this sync (upserts + deletes for 'upsert', all inserted rows for 'replace'). */
    count: number;
    /** Rows discarded by `shouldApplyRow`. Always 0 for 'replace' (hook only applies to 'upsert'). */
    skipped: number;
    /** INSERT/UPDATE rows among `count`. For 'replace', equals `count` (no tombstones there). */
    upserts: number;
    /** DELETE (tombstone) rows among `count`. Always 0 for 'replace'. */
    deletes: number;
    syncedAt: string;
}
export interface SyncState {
    syncedAt: string;
    rowCount: number;
    cursor: string | null;
}
export interface SyncHooks {
    onTableStart?(table: string): void;
    onTableComplete?(result: SyncTableResult): void;
    onTableError?(table: string, error: unknown): void;
    /**
     * Called synchronously for each fetched row of an 'upsert'-strategy table,
     * immediately before it would be written (not called for 'replace'
     * tables). Return false to skip writing that row this pass — e.g. because
     * the consumer has a newer local edit for it that hasn't synced yet. A
     * skipped row is simply left alone; it gets another chance on the next
     * sync pass since this engine has no per-row cursor or ack.
     */
    shouldApplyRow?(table: string, row: Record<string, unknown>): boolean;
    /**
     * Called after each batch of rows is applied and committed. For 'upsert'
     * tables this fires once per chunk of `batchSize` rows (and once per
     * fetched page when the remote streams pages). For 'replace'/shadow tables
     * it fires once per table, since the whole payload is applied atomically
     * in a single DELETE+INSERT (or shadow swap) transaction — `batchSize` is
     * still honored internally for the multi-row INSERT statements, but there
     * is only one logical "batch" to report.
     */
    onBatchComplete?(info: {
        table: string;
        batchIndex: number;
        batchSize: number;
        durationMs: number;
    }): void;
    /** Called once before `sync()` starts processing any table. Not called by `syncTable()` directly. */
    onSyncStart?(): void;
    /** Called once after `sync()` finishes processing every table. Not called by `syncTable()` directly. */
    onSyncComplete?(summary: SyncSummary): void;
}
export interface SyncEngineConfig {
    adapter: Adapter;
    remote: RemoteSource;
    tables: TableConfig[];
    syncStateTable?: string;
    hooks?: SyncHooks;
}
export interface SyncSummary {
    results: SyncTableResult[];
    errors: {
        table: string;
        error: unknown;
    }[];
}
export interface SyncEngine {
    sync(): Promise<SyncSummary>;
    syncTable(name: string): Promise<SyncTableResult>;
    getSyncState(): Promise<Map<string, SyncState>>;
}
export {};
//# sourceMappingURL=types.d.ts.map