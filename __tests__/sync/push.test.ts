import { createFakeExpoSqliteDb } from '../helpers/fake-expo-sqlite';
import { createExpoSqliteAdapter } from '../../src/adapters/expo-sqlite';
import { createPushEngine, DEFAULT_PUSH_OUTBOX_TABLE } from '../../src/sync/push';

function makeAdapter() {
  const database = createFakeExpoSqliteDb();
  return createExpoSqliteAdapter({ database });
}

describe('sync/push', () => {
  it('enqueues a mutation as pending', async () => {
    const adapter = makeAdapter();
    const engine = createPushEngine({ adapter });

    await engine.enqueue({ id: 'm1', type: 'create_parcela', payload: { name: 'p1' } });

    const { rows } = await adapter.run(`SELECT * FROM ${DEFAULT_PUSH_OUTBOX_TABLE} WHERE id = ?`, ['m1']);
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).status).toBe('pending');
    expect((rows[0] as any).attempts).toBe(0);
    expect(JSON.parse((rows[0] as any).payload)).toEqual({ name: 'p1' });
  });

  it('is idempotent by id (does not duplicate on re-enqueue)', async () => {
    const adapter = makeAdapter();
    const engine = createPushEngine({ adapter });

    await engine.enqueue({ id: 'm1', type: 'create_parcela', payload: { name: 'p1' } });
    await engine.enqueue({ id: 'm1', type: 'create_parcela', payload: { name: 'p1-updated' } });

    const { rows } = await adapter.run(`SELECT * FROM ${DEFAULT_PUSH_OUTBOX_TABLE} WHERE id = ?`, ['m1']);
    expect(rows).toHaveLength(1);
    // Re-enqueue updates the payload of a still-pending mutation (not a strict no-op ignore).
    expect(JSON.parse((rows[0] as any).payload)).toEqual({ name: 'p1-updated' });
  });

  it('does not re-enqueue (overwrite) a mutation that already succeeded', async () => {
    const adapter = makeAdapter();
    const engine = createPushEngine({ adapter });

    await engine.enqueue({ id: 'm1', type: 'create_parcela', payload: { name: 'p1' } });
    await engine.processQueue({ send: async () => ({ ok: true }) });

    await engine.enqueue({ id: 'm1', type: 'create_parcela', payload: { name: 'p1-again' } });

    const { rows } = await adapter.run(`SELECT * FROM ${DEFAULT_PUSH_OUTBOX_TABLE} WHERE id = ?`, ['m1']);
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).status).toBe('done');
    expect(JSON.parse((rows[0] as any).payload)).toEqual({ name: 'p1' });
  });

  it('processes a pending mutation successfully and marks it done', async () => {
    const adapter = makeAdapter();
    const engine = createPushEngine({ adapter });
    await engine.enqueue({ id: 'm1', type: 'create_parcela', payload: { name: 'p1' } });

    const sent: unknown[] = [];
    await engine.processQueue({
      send: async mutation => {
        sent.push(mutation.id);
        return { ok: true };
      },
    });

    expect(sent).toEqual(['m1']);
    const list = await engine.listByStatus('done');
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('m1');
    expect(list[0].attempts).toBe(1);
  });

  it('retries a failing mutation with exponential backoff until maxAttempts, then marks failed', async () => {
    const adapter = makeAdapter();
    const onMutationFailed = jest.fn();
    const engine = createPushEngine({
      adapter,
      maxAttempts: 3,
      backoff: () => 0, // no delay, so immediate consecutive processQueue calls can retry
      hooks: { onMutationFailed },
    });
    await engine.enqueue({ id: 'm1', type: 'create_parcela', payload: {} });

    for (let i = 0; i < 3; i++) {
      await engine.processQueue({ send: async () => { throw new Error('network down'); } });
    }

    const [failed] = await engine.listByStatus('failed');
    expect(failed).toBeDefined();
    expect(failed.attempts).toBe(3);
    expect(onMutationFailed).toHaveBeenCalledTimes(1);

    // A 4th pass must not attempt it again (it's terminal now).
    const sends = jest.fn(async () => { throw new Error('should not be called'); });
    await engine.processQueue({ send: sends });
    expect(sends).not.toHaveBeenCalled();
  });

  it('respects nextAttemptAt backoff: a just-failed mutation is skipped until its backoff window passes', async () => {
    const adapter = makeAdapter();
    const engine = createPushEngine({
      adapter,
      maxAttempts: 5,
      backoff: () => 60_000, // 1 minute, far beyond the test's real duration
    });
    await engine.enqueue({ id: 'm1', type: 'create_parcela', payload: {} });

    await engine.processQueue({ send: async () => { throw new Error('fail once'); } });

    const sends = jest.fn(async () => ({ ok: true }));
    await engine.processQueue({ send: sends });
    expect(sends).not.toHaveBeenCalled();

    const [pending] = await engine.listByStatus('pending');
    expect(pending.attempts).toBe(1);
  });

  it('skips (does not fail) a mutation whose dependsOn is not yet done', async () => {
    const adapter = makeAdapter();
    const engine = createPushEngine({ adapter });
    await engine.enqueue({ id: 'parcela-1', type: 'create_parcela', payload: {} });
    await engine.enqueue({ id: 'cultivo-1', type: 'create_cultivo', payload: {}, dependsOn: 'parcela-1' });

    const sends = jest.fn(async (mutation: { id: string }) => {
      if (mutation.id === 'cultivo-1') throw new Error('should not be sent yet');
      return { ok: true };
    });
    // Fail the dependency on purpose so it stays pending, not done.
    await engine.processQueue({
      send: async mutation => {
        if (mutation.id === 'parcela-1') throw new Error('dependency still pending');
        return sends(mutation);
      },
    });

    const [cultivo] = await (await adapter.run(`SELECT * FROM ${DEFAULT_PUSH_OUTBOX_TABLE} WHERE id = ?`, [
      'cultivo-1',
    ])).rows as any[];
    expect(cultivo.status).toBe('pending');
    expect(cultivo.attempts).toBe(0);
  });

  it('processes a mutation once its dependsOn mutation is done', async () => {
    const adapter = makeAdapter();
    const engine = createPushEngine({ adapter });
    await engine.enqueue({ id: 'parcela-1', type: 'create_parcela', payload: {} });
    await engine.enqueue({ id: 'cultivo-1', type: 'create_cultivo', payload: {}, dependsOn: 'parcela-1' });

    const sentIds: string[] = [];
    const send = async (mutation: { id: string }) => {
      sentIds.push(mutation.id);
      return { ok: true };
    };

    await engine.processQueue({ send }); // resolves parcela-1, cultivo-1 still blocked this pass
    await engine.processQueue({ send }); // now parcela-1 is done, cultivo-1 can go

    expect(sentIds).toEqual(['parcela-1', 'cultivo-1']);
    const done = await engine.listByStatus('done');
    expect(done.map(m => m.id).sort()).toEqual(['cultivo-1', 'parcela-1']);
  });

  it('getQueueState reports counts per status', async () => {
    const adapter = makeAdapter();
    const engine = createPushEngine({ adapter });
    await engine.enqueue({ id: 'm1', type: 'a', payload: {} });
    await engine.enqueue({ id: 'm2', type: 'a', payload: {} });
    await engine.processQueue({ send: async () => ({ ok: true }) });

    const state = await engine.getQueueState();
    expect(state.done).toBe(2);
    expect(state.pending).toBe(0);
  });

  it('calls onMutationStart and onMutationDone hooks', async () => {
    const adapter = makeAdapter();
    const onMutationStart = jest.fn();
    const onMutationDone = jest.fn();
    const engine = createPushEngine({ adapter, hooks: { onMutationStart, onMutationDone } });
    await engine.enqueue({ id: 'm1', type: 'a', payload: {} });

    await engine.processQueue({ send: async () => ({ ok: true }) });

    expect(onMutationStart).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
    expect(onMutationDone).toHaveBeenCalledWith(expect.objectContaining({ id: 'm1' }));
  });
});
