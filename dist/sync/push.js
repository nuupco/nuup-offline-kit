"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_MAX_BACKOFF_MS = exports.DEFAULT_MAX_ATTEMPTS = exports.DEFAULT_PUSH_OUTBOX_TABLE = void 0;
exports.ensurePushOutboxTable = ensurePushOutboxTable;
exports.createPushEngine = createPushEngine;
const validate_1 = require("./validate");
exports.DEFAULT_PUSH_OUTBOX_TABLE = '_nuup_push_outbox';
exports.DEFAULT_MAX_ATTEMPTS = 5;
exports.DEFAULT_MAX_BACKOFF_MS = 5 * 60000;
function defaultBackoff(baseDelayMs, maxBackoffMs) {
    return (attempts) => Math.min(2 ** attempts * baseDelayMs, maxBackoffMs);
}
function rowToMutation(row) {
    return {
        id: row.id,
        type: row.type,
        payload: JSON.parse(row.payload),
        dependsOn: row.depends_on ?? null,
        status: row.status,
        attempts: Number(row.attempts),
        nextAttemptAt: row.next_attempt_at ?? null,
    };
}
async function ensurePushOutboxTable(adapter, pushStateTable) {
    (0, validate_1.assertIdentifier)(pushStateTable, 'pushStateTable');
    await adapter.run(`CREATE TABLE IF NOT EXISTS ${pushStateTable} (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      depends_on TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )`);
}
/**
 * Known limitations:
 * - A mutation whose `dependsOn` points to an id that never existed (typo,
 *   or never enqueued) stays pending forever with no error or signal.
 * - Re-`enqueue`ing a mutation already in `failed` status is a silent no-op
 *   (the upsert only applies while status is `pending`); there is no way to
 *   retry a failed mutation by calling `enqueue` again with the same id.
 */
function createPushEngine({ adapter, pushStateTable = exports.DEFAULT_PUSH_OUTBOX_TABLE, maxAttempts = exports.DEFAULT_MAX_ATTEMPTS, baseDelayMs = 1000, maxBackoffMs = exports.DEFAULT_MAX_BACKOFF_MS, backoff = defaultBackoff(baseDelayMs, maxBackoffMs), hooks = {}, }) {
    (0, validate_1.assertIdentifier)(pushStateTable, 'pushStateTable');
    const { onMutationStart, onMutationDone, onMutationFailed } = hooks;
    let bootstrapped;
    function ensureBootstrap() {
        if (!bootstrapped) {
            bootstrapped = ensurePushOutboxTable(adapter, pushStateTable);
        }
        return bootstrapped;
    }
    async function enqueue(mutation) {
        await ensureBootstrap();
        const payload = JSON.stringify(mutation.payload);
        const dependsOn = mutation.dependsOn ?? null;
        // Idempotent by id: a mutation still `pending` gets its payload/dependsOn
        // refreshed (the caller re-enqueuing the same local change with newer
        // data); a mutation already in_flight/done/failed is left untouched so a
        // stale re-enqueue can't resurrect or duplicate a settled mutation.
        await adapter.run(`INSERT INTO ${pushStateTable} (id, type, payload, depends_on, status, attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, 'pending', 0, NULL)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         payload = excluded.payload,
         depends_on = excluded.depends_on
       WHERE ${pushStateTable}.status = 'pending'`, [mutation.id, mutation.type, payload, dependsOn]);
    }
    async function listByStatus(status) {
        await ensureBootstrap();
        const { rows } = await adapter.run(`SELECT * FROM ${pushStateTable} WHERE status = ?`, [status]);
        return rows.map(rowToMutation);
    }
    async function getQueueState() {
        await ensureBootstrap();
        const { rows } = await adapter.run(`SELECT status, COUNT(*) as n FROM ${pushStateTable} GROUP BY status`);
        const state = { pending: 0, in_flight: 0, done: 0, failed: 0 };
        rows.forEach(row => {
            state[row.status] = Number(row.n);
        });
        return state;
    }
    async function tryClaimInFlight(exec, id) {
        const { rowsAffected } = await exec(`UPDATE ${pushStateTable} SET status = 'in_flight' WHERE id = ? AND status = 'pending'`, [id]);
        return rowsAffected > 0;
    }
    async function markDone(exec, id) {
        await exec(`UPDATE ${pushStateTable} SET status = 'done', attempts = attempts + 1 WHERE id = ?`, [id]);
    }
    async function markRetryOrFailed(exec, id, attemptsBefore) {
        const attempts = attemptsBefore + 1;
        if (attempts >= maxAttempts) {
            await exec(`UPDATE ${pushStateTable} SET status = 'failed', attempts = ? WHERE id = ?`, [attempts, id]);
            return 'failed';
        }
        const delayMs = backoff(attempts);
        const nextAttemptAt = new Date(Date.now() + delayMs).toISOString();
        await exec(`UPDATE ${pushStateTable} SET status = 'pending', attempts = ?, next_attempt_at = ? WHERE id = ?`, [attempts, nextAttemptAt, id]);
        return 'pending';
    }
    async function processQueue({ send }) {
        await ensureBootstrap();
        const now = new Date().toISOString();
        const { rows } = await adapter.run(`SELECT o.* FROM ${pushStateTable} o
       WHERE o.status = 'pending'
         AND (o.next_attempt_at IS NULL OR o.next_attempt_at <= ?)
         AND (
           o.depends_on IS NULL
           OR EXISTS (SELECT 1 FROM ${pushStateTable} d WHERE d.id = o.depends_on AND d.status = 'done')
         )
       ORDER BY o.created_at ASC`, [now]);
        const candidates = rows.map(rowToMutation);
        for (const mutation of candidates) {
            // Atomic, conditional claim: only proceeds if this mutation is still
            // 'pending' at claim time. If a concurrent processQueue() already
            // claimed it (rowsAffected === 0), skip it entirely — it belongs to
            // the other invocation now, and we must not call send() for it.
            const claimed = await adapter.runInTransaction(exec => tryClaimInFlight(exec, mutation.id));
            if (!claimed)
                continue;
            if (onMutationStart)
                onMutationStart(mutation);
            try {
                await send(mutation);
                await adapter.runInTransaction(exec => markDone(exec, mutation.id));
                if (onMutationDone)
                    onMutationDone({ ...mutation, status: 'done', attempts: mutation.attempts + 1 });
            }
            catch (error) {
                const finalStatus = await adapter.runInTransaction(exec => markRetryOrFailed(exec, mutation.id, mutation.attempts));
                if (finalStatus === 'failed' && onMutationFailed) {
                    onMutationFailed({ ...mutation, status: 'failed', attempts: mutation.attempts + 1 }, error);
                }
            }
        }
    }
    return { enqueue, processQueue, listByStatus, getQueueState };
}
//# sourceMappingURL=push.js.map