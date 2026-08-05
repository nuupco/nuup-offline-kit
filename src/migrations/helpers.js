// `exec` is `(sql, params?) => Promise<{ rows: any[] }>`, provided by the db adapter.

async function columnExists(exec, table, column) {
  const { rows } = await exec(`PRAGMA table_info(${table})`);
  return rows.some(row => row.name === column);
}

async function addColumnIfNotExists(exec, table, column, type) {
  const exists = await columnExists(exec, table, column);
  if (!exists) {
    await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

async function tableExists(exec, table) {
  const { rows } = await exec(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    [table]
  );
  return rows.length > 0;
}

async function indexExists(exec, indexName) {
  const { rows } = await exec(
    `SELECT name FROM sqlite_master WHERE type='index' AND name=?`,
    [indexName]
  );
  return rows.length > 0;
}

async function createIndexIfNotExists(exec, indexName, createIndexSql) {
  const exists = await indexExists(exec, indexName);
  if (!exists) {
    await exec(createIndexSql);
  }
}

module.exports = {
  columnExists,
  addColumnIfNotExists,
  tableExists,
  indexExists,
  createIndexIfNotExists,
};
