import type { Adapter, Exec, ScopedExec, SyncState } from '../types';
export declare const DEFAULT_SYNC_STATE_TABLE = "_nuup_sync_state";
export declare function ensureSyncStateTable(adapter: Adapter, syncStateTable: string): Promise<void>;
export declare function recordSyncState(exec: ScopedExec, syncStateTable: string, table: string, rowCount: number): Promise<void>;
export declare function readSyncState(exec: Exec, syncStateTable: string, table: string): Promise<SyncState | undefined>;
export declare function readAllSyncState(adapter: Adapter, syncStateTable: string): Promise<Map<string, SyncState>>;
//# sourceMappingURL=state.d.ts.map