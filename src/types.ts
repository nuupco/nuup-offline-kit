// Published contracts for @nuup/offline-kit. Pure types — no runtime code.

export type SqlParam = string | number | null | Uint8Array;

export interface ExecOptions {
  read?: boolean;
}

export interface ExecResult<R = Record<string, unknown>> {
  rows: R[];
  rowsAffected: number;
  insertId: number | undefined;
}

export type Exec = <R = Record<string, unknown>>(
  sql: string,
  params?: SqlParam[],
  options?: ExecOptions
) => Promise<ExecResult<R>>;

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
  migrate(): Promise<{ appliedVersions: number[] }>;
  getAppliedVersions(): Promise<Map<number, string>>;
}

// expo-sqlite surface — structural, no peer import
export interface ExpoSqliteDatabase {
  getAllAsync<R = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<R[]>;
  runAsync(sql: string, params?: SqlParam[]): Promise<{ changes: number; lastInsertRowId: number }>;
  execAsync(sql: string): Promise<void>;
}

export interface ExpoSqliteModule {
  openDatabaseSync(name: string): ExpoSqliteDatabase;
}

// sync config — strategy-discriminated, primary key required only for 'upsert'
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
}

export type TableConfig = ReplaceTableConfig | UpsertTableConfig;

export interface RemoteSource {
  /**
   * `since` is the cursor persisted from this table's previous sync (`null`
   * on the first sync, or whenever no cursor was recorded). A RemoteSource
   * that doesn't support incremental fetching can ignore it and always
   * return the full set. `cursor` in the result, when present, is persisted
   * to `_nuup_sync_state` and passed back as `since` on the next sync.
   */
  fetch(arg: { table: string; since?: string | null }): Promise<
    Record<string, unknown>[] | { rows: Record<string, unknown>[]; cursor?: string | null }
  >;
}

export interface SyncTableResult {
  table: string;
  strategy: TableConfig['strategy'];
  count: number;
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
  errors: { table: string; error: unknown }[];
}

export interface SyncEngine {
  sync(): Promise<SyncSummary>;
  syncTable(name: string): Promise<SyncTableResult>;
  getSyncState(): Promise<Map<string, SyncState>>;
}
