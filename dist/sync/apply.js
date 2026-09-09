"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.chunk = chunk;
exports.applyReplace = applyReplace;
exports.applyUpsert = applyUpsert;
const validate_1 = require("./validate");
function chunk(items, size) {
    if (items.length === 0)
        return [];
    const result = [];
    for (let i = 0; i < items.length; i += size) {
        result.push(items.slice(i, i + size));
    }
    return result;
}
const DEFAULT_BATCH_SIZE = 200;
/**
 * Deletes all rows from `table.name`, then inserts the given rows.
 * SQL identifiers (table/column names) come only from the declared `table`
 * config — never from remote row keys. Values are always bound parameters.
 */
async function applyReplace(exec, table, rows) {
    const tableName = (0, validate_1.assertIdentifier)(table.name, 'table.name');
    const columns = table.columns.map((column, index) => (0, validate_1.assertIdentifier)(column, `columns[${index}]`));
    await exec(`DELETE FROM ${tableName}`);
    if (rows.length === 0)
        return 0;
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${placeholders}`;
    const batches = chunk(rows, table.batchSize ?? DEFAULT_BATCH_SIZE);
    for (const batch of batches) {
        for (const row of batch) {
            const values = columns.map(column => (row[column] ?? null));
            await exec(insertSql, values);
        }
    }
    return rows.length;
}
/**
 * Inserts new rows / updates existing rows by `table.primaryKey`, via
 * `INSERT ... ON CONFLICT(primaryKey) DO UPDATE`. SQL identifiers come only
 * from the declared `table` config; values are always bound parameters.
 */
async function applyUpsert(exec, table, rows) {
    const tableName = (0, validate_1.assertIdentifier)(table.name, 'table.name');
    const columns = table.columns.map((column, index) => (0, validate_1.assertIdentifier)(column, `columns[${index}]`));
    const primaryKey = (0, validate_1.assertIdentifier)(table.primaryKey, 'table.primaryKey');
    if (rows.length === 0)
        return 0;
    const placeholders = `(${columns.map(() => '?').join(', ')})`;
    const updateAssignments = columns
        .filter(column => column !== primaryKey)
        .map(column => `${column} = excluded.${column}`)
        .join(', ');
    const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${placeholders}` +
        (updateAssignments
            ? ` ON CONFLICT(${primaryKey}) DO UPDATE SET ${updateAssignments}`
            : ` ON CONFLICT(${primaryKey}) DO NOTHING`);
    const batches = chunk(rows, table.batchSize ?? DEFAULT_BATCH_SIZE);
    for (const batch of batches) {
        for (const row of batch) {
            const values = columns.map(column => (row[column] ?? null));
            await exec(insertSql, values);
        }
    }
    return rows.length;
}
//# sourceMappingURL=apply.js.map