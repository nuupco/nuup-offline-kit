import type { TableConfig } from '../types';

export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function assertIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || !IDENTIFIER_RE.test(value)) {
    throw new Error(`invalid ${label}: expected an identifier matching ${IDENTIFIER_RE}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function validateSyncTables(tables: unknown): TableConfig[] {
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error('tables must be a non-empty array');
  }

  return tables.map((table, index) => {
    if (typeof table !== 'object' || table === null) {
      throw new Error(`table config at index ${index} must be an object`);
    }

    const { name, strategy, columns, primaryKey, batchSize, allowEmpty } = table as Record<string, unknown>;

    assertIdentifier(name, `tables[${index}].name`);

    if (strategy !== 'replace' && strategy !== 'upsert') {
      throw new Error(
        `tables[${index}] ("${name}") has an invalid strategy: expected "replace" or "upsert", got ${JSON.stringify(
          strategy
        )}`
      );
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
        name: name as string,
        strategy: 'upsert',
        columns: columns as string[],
        primaryKey,
        ...(batchSize !== undefined ? { batchSize: batchSize as number } : {}),
      };
    }

    if (primaryKey !== undefined) {
      assertIdentifier(primaryKey, `tables[${index}].primaryKey`);
    }

    return {
      name: name as string,
      strategy: 'replace',
      columns: columns as string[],
      ...(primaryKey !== undefined ? { primaryKey: primaryKey as string } : {}),
      ...(allowEmpty !== undefined ? { allowEmpty: allowEmpty as boolean } : {}),
      ...(batchSize !== undefined ? { batchSize: batchSize as number } : {}),
    };
  });
}
