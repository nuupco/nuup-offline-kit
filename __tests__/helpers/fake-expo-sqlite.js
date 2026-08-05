const Database = require('better-sqlite3');

/**
 * Creates an in-memory better-sqlite3-backed fake that mimics the async
 * surface of an expo-sqlite (v13+) database instance: execAsync, runAsync,
 * getAllAsync. Used to drive adapter/runner tests without the real native
 * module (which cannot run under Jest/Node).
 */
function createFakeExpoSqliteDb() {
  const db = new Database(':memory:');

  return {
    _raw: db,
    async execAsync(sql) {
      db.exec(sql);
    },
    async runAsync(sql, params = []) {
      const info = db.prepare(sql).run(...params);
      return { changes: info.changes, lastInsertRowId: info.lastInsertRowid };
    },
    async getAllAsync(sql, params = []) {
      return db.prepare(sql).all(...params);
    },
  };
}

module.exports = { createFakeExpoSqliteDb };
