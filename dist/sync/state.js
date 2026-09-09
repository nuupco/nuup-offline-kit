"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SYNC_STATE_TABLE = void 0;
exports.ensureSyncStateTable = ensureSyncStateTable;
exports.recordSyncState = recordSyncState;
exports.readSyncState = readSyncState;
exports.readAllSyncState = readAllSyncState;
const validate_1 = require("./validate");
exports.DEFAULT_SYNC_STATE_TABLE = '_nuup_sync_state';
async function ensureSyncStateTable(adapter, syncStateTable) {
    (0, validate_1.assertIdentifier)(syncStateTable, 'syncStateTable');
    await adapter.run(`CREATE TABLE IF NOT EXISTS ${syncStateTable} (
      table_name TEXT PRIMARY KEY,
      synced_at TEXT DEFAULT (datetime('now')),
      row_count INTEGER NOT NULL
    )`);
}
async function recordSyncState(exec, syncStateTable, table, rowCount) {
    (0, validate_1.assertIdentifier)(syncStateTable, 'syncStateTable');
    await exec(`INSERT INTO ${syncStateTable} (table_name, synced_at, row_count) VALUES (?, datetime('now'), ?)
     ON CONFLICT(table_name) DO UPDATE SET synced_at = excluded.synced_at, row_count = excluded.row_count`, [table, rowCount]);
}
async function readSyncState(exec, syncStateTable, table) {
    (0, validate_1.assertIdentifier)(syncStateTable, 'syncStateTable');
    const { rows } = await exec(`SELECT synced_at, row_count FROM ${syncStateTable} WHERE table_name = ?`, [table]);
    const row = rows[0];
    if (!row)
        return undefined;
    return { syncedAt: row.synced_at, rowCount: row.row_count };
}
async function readAllSyncState(adapter, syncStateTable) {
    (0, validate_1.assertIdentifier)(syncStateTable, 'syncStateTable');
    const { rows } = await adapter.run(`SELECT table_name, synced_at, row_count FROM ${syncStateTable}`);
    const map = new Map();
    rows.forEach(row => map.set(row.table_name, { syncedAt: row.synced_at, rowCount: row.row_count }));
    return map;
}
//# sourceMappingURL=state.js.map