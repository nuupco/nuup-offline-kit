const { createFakeExpoSqliteDb } = require('../helpers/fake-expo-sqlite');

let fakeDbs;

jest.mock('expo-sqlite', () => ({
  openDatabaseSync: jest.fn(),
}), { virtual: true });

describe('createExpoSqliteAdapter', () => {
  let createExpoSqliteAdapter;
  let expoSqlite;

  beforeEach(() => {
    jest.resetModules();
    fakeDbs = [];
    // eslint-disable-next-line global-require
    expoSqlite = require('expo-sqlite');
    expoSqlite.openDatabaseSync.mockImplementation(() => {
      const fake = createFakeExpoSqliteDb();
      fakeDbs.push(fake);
      return fake;
    });
    // eslint-disable-next-line global-require
    ({ createExpoSqliteAdapter } = require('../../src/adapters/expo-sqlite'));
  });

  describe('factory input validation', () => {
    it('throws a descriptive error when neither databaseName nor database is given', () => {
      expect(() => createExpoSqliteAdapter({})).toThrow(/databaseName.*database|database.*databaseName/i);
    });

    it('throws a descriptive error when both databaseName and database are given', () => {
      const database = createFakeExpoSqliteDb();
      expect(() => createExpoSqliteAdapter({ databaseName: 'app.db', database })).toThrow(
        /exactly one|not both|either/i
      );
    });

    it('lazily calls openDatabaseSync exactly once when given databaseName', async () => {
      const adapter = createExpoSqliteAdapter({ databaseName: 'app.db' });
      expect(expoSqlite.openDatabaseSync).not.toHaveBeenCalled();

      await adapter.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      expect(expoSqlite.openDatabaseSync).toHaveBeenCalledTimes(1);
      expect(expoSqlite.openDatabaseSync).toHaveBeenCalledWith('app.db');

      await adapter.run('CREATE TABLE t2 (id INTEGER PRIMARY KEY)');
      expect(expoSqlite.openDatabaseSync).toHaveBeenCalledTimes(1);
    });

    it('uses a given already-open database instance without opening one', async () => {
      const database = createFakeExpoSqliteDb();
      const adapter = createExpoSqliteAdapter({ database });

      await adapter.run('CREATE TABLE t (id INTEGER PRIMARY KEY)');
      expect(expoSqlite.openDatabaseSync).not.toHaveBeenCalled();
    });
  });

  describe('adapter contract scope', () => {
    it('exposes only run and runInTransaction as public methods', () => {
      const database = createFakeExpoSqliteDb();
      const adapter = createExpoSqliteAdapter({ database });
      expect(Object.keys(adapter).sort()).toEqual(['run', 'runInTransaction']);
    });
  });

  describe('read/write dispatch', () => {
    let adapter;

    beforeEach(async () => {
      const database = createFakeExpoSqliteDb();
      adapter = createExpoSqliteAdapter({ database });
      await adapter.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    });

    it('dispatches SELECT via read path and returns a flat rows array', async () => {
      await adapter.run('INSERT INTO users (name) VALUES (?)', ['alice']);
      const result = await adapter.run('SELECT * FROM users');

      expect(Array.isArray(result.rows)).toBe(true);
      expect(result.rows).toEqual([{ id: 1, name: 'alice' }]);
      expect(result.rows._array).toBeUndefined();
      expect(typeof result.rows.item).not.toBe('function');
    });

    it('dispatches INSERT via write path and returns rowsAffected/insertId', async () => {
      const result = await adapter.run('INSERT INTO users (name) VALUES (?)', ['bob']);

      expect(result.rowsAffected).toBe(1);
      expect(result.insertId).toBe(1);
      expect(result.rows).toEqual([]);
    });

    it('defaults a WITH ... SELECT statement to the read path', async () => {
      await adapter.run('INSERT INTO users (name) VALUES (?)', ['carol']);
      const result = await adapter.run('WITH cte AS (SELECT * FROM users) SELECT * FROM cte');

      expect(result.rows).toEqual([{ id: 1, name: 'carol' }]);
    });

    it('honors an explicit { read: true } hint overriding regex classification', async () => {
      const result = await adapter.run('INSERT INTO users (name) VALUES (?) RETURNING id, name', ['dave'], {
        read: true,
      });

      expect(result.rows).toEqual([{ id: 1, name: 'dave' }]);
    });
  });

  describe('transaction lifecycle', () => {
    let adapter;

    beforeEach(async () => {
      const database = createFakeExpoSqliteDb();
      adapter = createExpoSqliteAdapter({ database });
      await adapter.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    });

    it('commits all writes on success and makes them visible afterwards', async () => {
      await adapter.runInTransaction(async exec => {
        await exec('INSERT INTO users (name) VALUES (?)', ['alice']);
        await exec('INSERT INTO users (name) VALUES (?)', ['bob']);
      });

      const { rows } = await adapter.run('SELECT * FROM users');
      expect(rows).toHaveLength(2);
    });

    it('rolls back and rethrows the original error on failure, leaving no partial rows', async () => {
      const boom = new Error('boom');

      await expect(
        adapter.runInTransaction(async exec => {
          await exec('INSERT INTO users (name) VALUES (?)', ['alice']);
          throw boom;
        })
      ).rejects.toBe(boom);

      const { rows } = await adapter.run('SELECT * FROM users');
      expect(rows).toHaveLength(0);
    });
  });

  describe('serialized concurrent transactions', () => {
    it("does not start the second transaction's BEGIN until the first commits", async () => {
      const database = createFakeExpoSqliteDb();
      adapter = createExpoSqliteAdapter({ database });
      await adapter.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

      const calls = [];
      const originalExecAsync = database.execAsync.bind(database);
      database.execAsync = async sql => {
        calls.push(sql.trim().split(/\s+/)[0].toUpperCase());
        return originalExecAsync(sql);
      };

      let resolveFirst;
      const firstStarted = new Promise(resolve => {
        resolveFirst = resolve;
      });

      const first = adapter.runInTransaction(async exec => {
        resolveFirst();
        await new Promise(r => setTimeout(r, 20));
        await exec('INSERT INTO users (name) VALUES (?)', ['alice']);
      });

      await firstStarted;
      const second = adapter.runInTransaction(async exec => {
        await exec('INSERT INTO users (name) VALUES (?)', ['bob']);
      });

      await Promise.all([first, second]);

      const beginIndexes = calls
        .map((c, i) => (c === 'BEGIN' ? i : -1))
        .filter(i => i !== -1);
      const commitOrRollbackIndexes = calls
        .map((c, i) => (c === 'COMMIT' || c === 'ROLLBACK' ? i : -1))
        .filter(i => i !== -1);

      expect(beginIndexes).toHaveLength(2);
      expect(commitOrRollbackIndexes).toHaveLength(2);
      // second BEGIN happens after first COMMIT/ROLLBACK
      expect(beginIndexes[1]).toBeGreaterThan(commitOrRollbackIndexes[0]);
    });
  });

  describe('nested transaction guard', () => {
    it('rejects synchronously with a clear error and issues no additional BEGIN', async () => {
      const database = createFakeExpoSqliteDb();
      adapter = createExpoSqliteAdapter({ database });
      await adapter.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

      const calls = [];
      const originalExecAsync = database.execAsync.bind(database);
      database.execAsync = async sql => {
        calls.push(sql.trim().split(/\s+/)[0].toUpperCase());
        return originalExecAsync(sql);
      };

      const innerFn = jest.fn(async () => {});

      await adapter.runInTransaction(async exec => {
        await expect(exec.runInTransaction(innerFn)).rejects.toThrow(
          /nested transactions? (is |are )?not supported/i
        );
      });

      expect(innerFn).not.toHaveBeenCalled();
      const beginCount = calls.filter(c => c === 'BEGIN').length;
      expect(beginCount).toBe(1);
    });
  });

  describe('scoped exec handle shape', () => {
    let adapter;

    beforeEach(async () => {
      const database = createFakeExpoSqliteDb();
      adapter = createExpoSqliteAdapter({ database });
      await adapter.run('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
    });

    it('exec is callable with the pre-change signature', async () => {
      await adapter.runInTransaction(async exec => {
        const result = await exec('INSERT INTO users (name) VALUES (?)', ['alice']);
        expect(result.rowsAffected).toBe(1);
      });
    });

    it('exec.run behaves identically to exec', async () => {
      await adapter.runInTransaction(async exec => {
        expect(typeof exec.run).toBe('function');
        const result = await exec.run('INSERT INTO users (name) VALUES (?)', ['bob']);
        expect(result.rowsAffected).toBe(1);
      });

      const { rows } = await adapter.run('SELECT * FROM users');
      expect(rows).toEqual([{ id: 1, name: 'bob' }]);
    });

    it('exec is frozen', async () => {
      await adapter.runInTransaction(async exec => {
        expect(Object.isFrozen(exec)).toBe(true);
      });
    });

    it('exec.runInTransaction has arity 1', async () => {
      await adapter.runInTransaction(async exec => {
        expect(typeof exec.runInTransaction).toBe('function');
        expect(exec.runInTransaction.length).toBe(1);
      });
    });
  });

  describe('source does not reference async_hooks', () => {
    it('contains no async_hooks or AsyncLocalStorage reference', () => {
      // eslint-disable-next-line global-require
      const fs = require('fs');
      // eslint-disable-next-line global-require
      const path = require('path');
      const source = fs.readFileSync(
        path.join(__dirname, '../../src/adapters/expo-sqlite.js'),
        'utf8'
      );
      expect(source).not.toMatch(/async_hooks/);
      expect(source).not.toMatch(/AsyncLocalStorage/);
    });
  });

  describe('public adapter shape regression', () => {
    it('createExpoSqliteAdapter returns exactly run and runInTransaction with unchanged arities', () => {
      const database = createFakeExpoSqliteDb();
      const adapter = createExpoSqliteAdapter({ database });

      expect(Object.keys(adapter).sort()).toEqual(['run', 'runInTransaction']);
      expect(createExpoSqliteAdapter.length).toBe(0);
      expect(adapter.run.length).toBe(1);
      expect(adapter.runInTransaction.length).toBe(1);
    });
  });
});
