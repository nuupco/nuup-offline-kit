import type { Adapter, ScopedExec } from '../types';
import { assertIdentifier } from './validate';

export const DEFAULT_PUSH_OUTBOX_TABLE = '_nuup_push_outbox';
export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60_000;

export type PushMutationStatus = 'pending' | 'in_flight' | 'done' | 'failed';

/** A mutation as supplied by the caller to `enqueue`. The kit never generates ids. */
export interface PushMutationInput {
  id: string;
  type: string;
  payload: unknown;
  /** id of another mutation that must be `done` before this one may be sent. */
  dependsOn?: string | null;
}

/** A mutation as persisted and returned by read APIs. */
export interface PushMutation {
  id: string;
  type: string;
  payload: unknown;
  dependsOn: string | null;
  status: PushMutationStatus;
  attempts: number;
  nextAttemptAt: string | null;
  /** True when `dependsOn` points to an id that was never enqueued. */
  orphaned: boolean;
}

export interface PushQueueState {
  pending: number;
  in_flight: number;
  done: number;
  failed: number;
}

export interface PushHooks {
  onMutationStart?(mutation: PushMutation): void;
  onMutationDone?(mutation: PushMutation): void;
  onMutationFailed?(mutation: PushMutation, error: unknown): void;
}

/** The caller's actual network call. The kit knows nothing about HTTP. */
export type PushSend = (mutation: PushMutation) => Promise<unknown>;

export interface PushEngineConfig {
  adapter: Adapter;
  pushStateTable?: string;
  /** Mutations are marked `failed` (no more retries) once `attempts` reaches this. Default 5. */
  maxAttempts?: number;
  /** Computes the delay (ms) before the next attempt, given the attempt count after the failure. Default exponential: 2^attempts * baseDelayMs, capped at maxBackoffMs. */
  backoff?(attempts: number): number;
  baseDelayMs?: number;
  maxBackoffMs?: number;
  hooks?: PushHooks;
}

export interface PushEngine {
  enqueue(mutation: PushMutationInput): Promise<void>;
  processQueue(args: { send: PushSend }): Promise<void>;
  listByStatus(status: PushMutationStatus): Promise<PushMutation[]>;
  getQueueState(): Promise<PushQueueState>;
  /** Resets all `in_flight` mutations back to `pending` (recovery from a crash mid-push). Returns the number of rows affected. */
  resetStuckInFlight(): Promise<number>;
  /** Requeues `failed` mutations as `pending` (attempts/next_attempt_at reset). With `id`, requeues only that mutation (must be `failed`, else a no-op). Without `id`, requeues all `failed` mutations. Returns the number of rows affected. */
  requeueFailed(id?: string): Promise<number>;
  /** Cancels (deletes) a `pending` or `failed` mutation. Returns `false` (no-op) for `in_flight`/`done`/unknown ids. */
  cancel(id: string): Promise<boolean>;
}

function defaultBackoff(baseDelayMs: number, maxBackoffMs: number) {
  return (attempts: number) => Math.min(2 ** attempts * baseDelayMs, maxBackoffMs);
}

function rowToMutation(row: Record<string, unknown>): PushMutation {
  return {
    id: row.id as string,
    type: row.type as string,
    payload: JSON.parse(row.payload as string),
    dependsOn: (row.depends_on as string | null) ?? null,
    status: row.status as PushMutationStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: (row.next_attempt_at as string | null) ?? null,
    orphaned: Boolean(Number(row.orphaned ?? 0)),
  };
}

export async function ensurePushOutboxTable(adapter: Adapter, pushStateTable: string): Promise<void> {
  assertIdentifier(pushStateTable, 'pushStateTable');
  await adapter.run(
    `CREATE TABLE IF NOT EXISTS ${pushStateTable} (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      depends_on TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`
  );
  await adapter.run(
    `CREATE INDEX IF NOT EXISTS ${pushStateTable}_status_next_attempt_idx ON ${pushStateTable} (status, next_attempt_at)`
  );
}

/**
 * Known limitations:
 * - A mutation whose `dependsOn` points to an id that never existed (typo,
 *   or never enqueued) stays pending forever with no error or signal.
 * - Re-`enqueue`ing a mutation already in `failed` status is a silent no-op
 *   (the upsert only applies while status is `pending`); there is no way to
 *   retry a failed mutation by calling `enqueue` again with the same id.
 */
export function createPushEngine({
  adapter,
  pushStateTable = DEFAULT_PUSH_OUTBOX_TABLE,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  baseDelayMs = 1000,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  backoff = defaultBackoff(baseDelayMs, maxBackoffMs),
  hooks = {},
}: PushEngineConfig): PushEngine {
  assertIdentifier(pushStateTable, 'pushStateTable');
  const { onMutationStart, onMutationDone, onMutationFailed } = hooks;

  let bootstrapped: Promise<void> | undefined;
  function ensureBootstrap(): Promise<void> {
    if (!bootstrapped) {
      bootstrapped = ensurePushOutboxTable(adapter, pushStateTable);
    }
    return bootstrapped;
  }

  async function enqueue(mutation: PushMutationInput): Promise<void> {
    await ensureBootstrap();
    const payload = JSON.stringify(mutation.payload);
    const dependsOn = mutation.dependsOn ?? null;
    // Idempotent by id: a mutation still `pending` gets its payload/dependsOn
    // refreshed (the caller re-enqueuing the same local change with newer
    // data); a mutation already in_flight/done/failed is left untouched so a
    // stale re-enqueue can't resurrect or duplicate a settled mutation.
    await adapter.run(
      `INSERT INTO ${pushStateTable} (id, type, payload, depends_on, status, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, 'pending', 0, NULL)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         payload = excluded.payload,
         depends_on = excluded.depends_on
       WHERE ${pushStateTable}.status = 'pending'`,
      [mutation.id, mutation.type, payload, dependsOn]
    );
  }

  async function listByStatus(status: PushMutationStatus): Promise<PushMutation[]> {
    await ensureBootstrap();
    const { rows } = await adapter.run(
      `SELECT o.*, (o.depends_on IS NOT NULL AND d.id IS NULL) AS orphaned
       FROM ${pushStateTable} o
       LEFT JOIN ${pushStateTable} d ON d.id = o.depends_on
       WHERE o.status = ?`,
      [status]
    );
    return rows.map(rowToMutation);
  }

  async function getQueueState(): Promise<PushQueueState> {
    await ensureBootstrap();
    const { rows } = await adapter.run<{ status: PushMutationStatus; n: number }>(
      `SELECT status, COUNT(*) as n FROM ${pushStateTable} GROUP BY status`
    );
    const state: PushQueueState = { pending: 0, in_flight: 0, done: 0, failed: 0 };
    rows.forEach(row => {
      state[row.status] = Number(row.n);
    });
    return state;
  }

  async function tryClaimInFlight(exec: ScopedExec, id: string): Promise<boolean> {
    const { rowsAffected } = await exec(
      `UPDATE ${pushStateTable} SET status = 'in_flight' WHERE id = ? AND status = 'pending'`,
      [id]
    );
    return rowsAffected > 0;
  }

  async function markDone(exec: ScopedExec, id: string): Promise<void> {
    await exec(`UPDATE ${pushStateTable} SET status = 'done', attempts = attempts + 1 WHERE id = ?`, [id]);
  }

  async function markRetryOrFailed(exec: ScopedExec, id: string, attemptsBefore: number): Promise<PushMutationStatus> {
    const attempts = attemptsBefore + 1;
    if (attempts >= maxAttempts) {
      await exec(`UPDATE ${pushStateTable} SET status = 'failed', attempts = ? WHERE id = ?`, [attempts, id]);
      return 'failed';
    }
    const delayMs = backoff(attempts);
    const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
    await exec(
      `UPDATE ${pushStateTable} SET status = 'pending', attempts = ?, next_attempt_at = ? WHERE id = ?`,
      [attempts, nextAttemptAt, id]
    );
    return 'pending';
  }

  async function resetStuckInFlight(): Promise<number> {
    await ensureBootstrap();
    const { rowsAffected } = await adapter.run(
      `UPDATE ${pushStateTable} SET status = 'pending' WHERE status = 'in_flight'`
    );
    return rowsAffected;
  }

  async function requeueFailed(id?: string): Promise<number> {
    await ensureBootstrap();
    if (id !== undefined) {
      const { rowsAffected } = await adapter.run(
        `UPDATE ${pushStateTable} SET status = 'pending', attempts = 0, next_attempt_at = NULL WHERE id = ? AND status = 'failed'`,
        [id]
      );
      return rowsAffected;
    }
    const { rowsAffected } = await adapter.run(
      `UPDATE ${pushStateTable} SET status = 'pending', attempts = 0, next_attempt_at = NULL WHERE status = 'failed'`
    );
    return rowsAffected;
  }

  async function cancel(id: string): Promise<boolean> {
    await ensureBootstrap();
    const { rowsAffected } = await adapter.run(
      `DELETE FROM ${pushStateTable} WHERE id = ? AND status IN ('pending', 'failed')`,
      [id]
    );
    return rowsAffected > 0;
  }

  async function processQueue({ send }: { send: PushSend }): Promise<void> {
    await ensureBootstrap();
    const now = new Date().toISOString();
    const { rows } = await adapter.run(
      `SELECT o.* FROM ${pushStateTable} o
       WHERE o.status = 'pending'
         AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
         AND (
           o.depends_on IS NULL
           OR EXISTS (SELECT 1 FROM ${pushStateTable} d WHERE d.id = o.depends_on AND d.status = 'done')
         )
       ORDER BY o.created_at ASC`,
      [now]
    );
    const candidates = rows.map(rowToMutation);

    for (const mutation of candidates) {
      // Atomic, conditional claim: only proceeds if this mutation is still
      // 'pending' at claim time. If a concurrent processQueue() already
      // claimed it (rowsAffected === 0), skip it entirely — it belongs to
      // the other invocation now, and we must not call send() for it.
      const claimed = await adapter.runInTransaction(exec => tryClaimInFlight(exec, mutation.id));
      if (!claimed) continue;
      if (onMutationStart) onMutationStart(mutation);

      try {
        await send(mutation);
        await adapter.runInTransaction(exec => markDone(exec, mutation.id));
        if (onMutationDone) onMutationDone({ ...mutation, status: 'done', attempts: mutation.attempts + 1 });
      } catch (error) {
        const finalStatus = await adapter.runInTransaction(exec =>
          markRetryOrFailed(exec, mutation.id, mutation.attempts)
        );
        if (finalStatus === 'failed' && onMutationFailed) {
          onMutationFailed({ ...mutation, status: 'failed', attempts: mutation.attempts + 1 }, error);
        }
      }
    }
  }

  return { enqueue, processQueue, listByStatus, getQueueState, resetStuckInFlight, requeueFailed, cancel };
}
