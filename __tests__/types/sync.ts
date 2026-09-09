// Type-only contract assertions for the sync engine's public types.
// Not a Jest test file (excluded from testMatch); checked via `tsc --noEmit`.
import type { UpsertTableConfig, ReplaceTableConfig, TableConfig } from '../../src/types';

// A valid replace config needs no primaryKey.
const replaceOk: ReplaceTableConfig = { name: 'assistants', strategy: 'replace', columns: ['id', 'name'] };

// A valid upsert config must declare primaryKey.
const upsertOk: UpsertTableConfig = {
  name: 'assistants',
  strategy: 'upsert',
  columns: ['id', 'name'],
  primaryKey: 'id',
};

// @ts-expect-error — upsert without primaryKey must be a compile error.
const upsertMissingPrimaryKey: UpsertTableConfig = {
  name: 'assistants',
  strategy: 'upsert',
  columns: ['id', 'name'],
};

const tables: TableConfig[] = [replaceOk, upsertOk];

export { replaceOk, upsertOk, upsertMissingPrimaryKey, tables };
