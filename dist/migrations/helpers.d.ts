import type { Exec } from '../types';
export declare function columnExists(exec: Exec, table: string, column: string): Promise<boolean>;
export declare function addColumnIfNotExists(exec: Exec, table: string, column: string, type: string): Promise<void>;
export declare function tableExists(exec: Exec, table: string): Promise<boolean>;
export declare function indexExists(exec: Exec, indexName: string): Promise<boolean>;
export declare function createIndexIfNotExists(exec: Exec, indexName: string, createIndexSql: string): Promise<void>;
//# sourceMappingURL=helpers.d.ts.map