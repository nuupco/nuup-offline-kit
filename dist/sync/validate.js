"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IDENTIFIER_RE = void 0;
exports.assertIdentifier = assertIdentifier;
exports.validateSyncTables = validateSyncTables;
exports.IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdentifier(value, label) {
    if (typeof value !== 'string' || !exports.IDENTIFIER_RE.test(value)) {
        throw new Error(`invalid ${label}: expected an identifier matching ${exports.IDENTIFIER_RE}, got ${JSON.stringify(value)}`);
    }
    return value;
}
function validateSyncTables(tables) {
    if (!Array.isArray(tables) || tables.length === 0) {
        throw new Error('tables must be a non-empty array');
    }
    return tables.map((table, index) => {
        if (typeof table !== 'object' || table === null) {
            throw new Error(`table config at index ${index} must be an object`);
        }
        const { name, strategy, columns, primaryKey, batchSize, allowEmpty } = table;
        assertIdentifier(name, `tables[${index}].name`);
        if (strategy !== 'replace' && strategy !== 'upsert') {
            throw new Error(`tables[${index}] ("${name}") has an invalid strategy: expected "replace" or "upsert", got ${JSON.stringify(strategy)}`);
        }
        if (!Array.isArray(columns) || columns.length === 0) {
            throw new Error(`tables[${index}] ("${name}") must declare a non-empty "columns" array`);
        }
        columns.forEach((column, columnIndex) => assertIdentifier(column, `tables[${index}].columns[${columnIndex}]`));
        if (strategy === 'upsert') {
            if (typeof primaryKey !== 'string' || primaryKey.length === 0) {
                throw new Error(`tables[${index}] ("${name}") uses strategy "upsert" and must declare a "primaryKey"`);
            }
            assertIdentifier(primaryKey, `tables[${index}].primaryKey`);
            if (!columns.includes(primaryKey)) {
                throw new Error(`tables[${index}] ("${name}") primaryKey "${primaryKey}" must be included in "columns"`);
            }
            return {
                name: name,
                strategy: 'upsert',
                columns: columns,
                primaryKey,
                ...(batchSize !== undefined ? { batchSize: batchSize } : {}),
            };
        }
        if (primaryKey !== undefined) {
            assertIdentifier(primaryKey, `tables[${index}].primaryKey`);
        }
        return {
            name: name,
            strategy: 'replace',
            columns: columns,
            ...(primaryKey !== undefined ? { primaryKey: primaryKey } : {}),
            ...(allowEmpty !== undefined ? { allowEmpty: allowEmpty } : {}),
            ...(batchSize !== undefined ? { batchSize: batchSize } : {}),
        };
    });
}
//# sourceMappingURL=validate.js.map