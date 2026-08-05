const migrations = require('./migrations');
const { createExpoSqliteAdapter } = require('./adapters/expo-sqlite');

module.exports = {
  ...migrations,
  createExpoSqliteAdapter,
};
