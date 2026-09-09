import type { Adapter, Exec, ExecOptions, ExecResult, ExpoSqliteDatabase, ExpoSqliteModule, ScopedExec, SqlParam } from '../types';

const READ_REGEX = /^\s*(?:SELECT|PRAGMA|EXPLAIN|WITH)\b/i;

const NESTED_TRANSACTION_ERROR =
  'createExpoSqliteAdapter: nested transactions are not supported (savepoints are out of scope). ' +
  'Use the exec function passed to the outer transaction.';

/**
 * Builds the scoped `exec` handle passed to a transaction's `fn`.
 *
 * The returned value is callable with the pre-change signature
 * `await exec(sql, params, options)`, and additionally exposes:
 * - `exec.run`: an alias for `exec` itself.
 * - `exec.runInTransaction`: always rejects with `NESTED_TRANSACTION_ERROR`,
 *   without issuing a `BEGIN` or invoking its argument. This is the only
 *   detected nesting path; nesting via the root adapter handle
 *   (`adapter.runInTransaction`) remains undetected (documented misuse).
 *
 * The handle is frozen before being handed to `fn`.
 */
export function createScopedExec(execute: Exec): ScopedExec {
  const scopedExec = ((sql: string, params: SqlParam[] = [], options: ExecOptions = {}) =>
    execute(sql, params, options)) as ScopedExec;
  (scopedExec as any).run = scopedExec;
  (scopedExec as any).runInTransaction = async (_fn: (exec: ScopedExec) => unknown) => {
    throw new Error(NESTED_TRANSACTION_ERROR);
  };
  return Object.freeze(scopedExec);
}

export function createExpoSqliteAdapter(
  { databaseName, database }: { databaseName?: string; database?: ExpoSqliteDatabase } = {}
): Adapter {
  if (databaseName === undefined && database === undefined) {
    return _throwInputError(
      'createExpoSqliteAdapter: exactly one of "databaseName" or "database" is required, but neither was given.'
    );
  }
  if (databaseName !== undefined && database !== undefined) {
    return _throwInputError(
      'createExpoSqliteAdapter: exactly one of "databaseName" or "database" is required, not both.'
    );
  }

  let db = database;
  let queue: Promise<unknown> = Promise.resolve();

  function resolveDb(): ExpoSqliteDatabase {
    if (!db) {
      // eslint-disable-next-line global-require
      const expoSqlite = require('expo-sqlite') as ExpoSqliteModule;
      db = expoSqlite.openDatabaseSync(databaseName as string);
    }
    return db;
  }

  const execute: Exec = async function execute<R = Record<string, unknown>>(
    sql: string,
    params: SqlParam[] = [],
    options: ExecOptions = {}
  ): Promise<ExecResult<R>> {
    const conn = resolveDb();
    const isRead = options.read !== undefined ? options.read : READ_REGEX.test(sql);

    if (isRead) {
      const rows = await conn.getAllAsync<R>(sql, params);
      return { rows, rowsAffected: 0, insertId: undefined };
    }

    const { changes, lastInsertRowId } = await conn.runAsync(sql, params);
    return { rows: [], rowsAffected: changes, insertId: lastInsertRowId };
  };

  const run: Exec = async function run<R = Record<string, unknown>>(
    sql: string,
    params: SqlParam[] = [],
    options: ExecOptions = {}
  ): Promise<ExecResult<R>> {
    return execute<R>(sql, params, options);
  };

  async function runInTransaction<T>(fn: (exec: ScopedExec) => Promise<T> | T): Promise<T> {
    const job = async (): Promise<T> => {
      const conn = resolveDb();
      await conn.execAsync('BEGIN');
      try {
        const result = await fn(createScopedExec(execute));
        await conn.execAsync('COMMIT');
        return result;
      } catch (error) {
        await conn.execAsync('ROLLBACK');
        throw error;
      }
    };

    const result = queue.then(job) as Promise<T>;
    // Prevent unhandled rejection tracking on the internal queue chain while
    // still propagating the actual error to the caller via `result`.
    queue = result.catch(() => {});
    return result;
  }

  return { run, runInTransaction };
}

function _throwInputError(message: string): never {
  throw new Error(message);
}
