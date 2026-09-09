export { createMigrationRunner, DEFAULT_TABLE } from './runner';
export { validateMigrations } from './validate';
export { checksum, checksumStatements } from './checksum';
export {
  columnExists,
  addColumnIfNotExists,
  tableExists,
  indexExists,
  createIndexIfNotExists,
} from './helpers';
export type {
  Adapter,
  Exec,
  ExecOptions,
  ExecResult,
  Migration,
  MigrationHooks,
  MigrationRunner,
  MigrationStatement,
  ScopedExec,
  SqlParam,
} from '../types';
