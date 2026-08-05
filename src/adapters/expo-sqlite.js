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
function createScopedExec(execute) {
  const scopedExec = (sql, params = [], options = {}) => execute(sql, params, options);
  scopedExec.run = scopedExec;
  // eslint-disable-next-line no-unused-vars
  scopedExec.runInTransaction = async fn => {
    throw new Error(NESTED_TRANSACTION_ERROR);
  };
  return Object.freeze(scopedExec);
}

function createExpoSqliteAdapter({ databaseName, database } = {}) {
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
  let queue = Promise.resolve();

  function resolveDb() {
    if (!db) {
      // eslint-disable-next-line global-require
      const expoSqlite = require('expo-sqlite');
      db = expoSqlite.openDatabaseSync(databaseName);
    }
    return db;
  }

  async function execute(sql, params = [], options = {}) {
    const conn = resolveDb();
    const isRead = options.read !== undefined ? options.read : READ_REGEX.test(sql);

    if (isRead) {
      const rows = await conn.getAllAsync(sql, params);
      return { rows, rowsAffected: 0, insertId: undefined };
    }

    const { changes, lastInsertRowId } = await conn.runAsync(sql, params);
    return { rows: [], rowsAffected: changes, insertId: lastInsertRowId };
  }

  async function run(sql, params = [], options = {}) {
    return execute(sql, params, options);
  }

  async function runInTransaction(fn) {
    const job = async () => {
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

    const result = queue.then(job);
    // Prevent unhandled rejection tracking on the internal queue chain while
    // still propagating the actual error to the caller via `result`.
    queue = result.catch(() => {});
    return result;
  }

  return { run, runInTransaction };
}

function _throwInputError(message) {
  throw new Error(message);
}

module.exports = { createExpoSqliteAdapter };
