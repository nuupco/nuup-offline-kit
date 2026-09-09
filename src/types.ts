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
}

export interface UpsertTableConfig extends BaseTableConfig {
  strategy: 'upsert';
  primaryKey: string;
}

export type TableConfig = ReplaceTableConfig | UpsertTableConfig;

export interface RemoteSource {
  fetch(arg: { table: string }): Promise<Record<string, unknown>[]>;
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
}

export interface SyncHooks {
  onTableStart?(table: string): void;
  onTableComplete?(result: SyncTableResult): void;
  onTableError?(table: string, error: unknown): void;
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
