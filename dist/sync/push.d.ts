import type { Adapter } from '../types';
export declare const DEFAULT_PUSH_OUTBOX_TABLE = "_nuup_push_outbox";
export declare const DEFAULT_MAX_ATTEMPTS = 5;
export declare const DEFAULT_MAX_BACKOFF_MS: number;
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
    processQueue(args: {
        send: PushSend;
    }): Promise<void>;
    listByStatus(status: PushMutationStatus): Promise<PushMutation[]>;
    getQueueState(): Promise<PushQueueState>;
}
export declare function ensurePushOutboxTable(adapter: Adapter, pushStateTable: string): Promise<void>;
/**
 * Known limitations:
 * - A mutation whose `dependsOn` points to an id that never existed (typo,
 *   or never enqueued) stays pending forever with no error or signal.
 * - Re-`enqueue`ing a mutation already in `failed` status is a silent no-op
 *   (the upsert only applies while status is `pending`); there is no way to
 *   retry a failed mutation by calling `enqueue` again with the same id.
 */
export declare function createPushEngine({ adapter, pushStateTable, maxAttempts, baseDelayMs, maxBackoffMs, backoff, hooks, }: PushEngineConfig): PushEngine;
//# sourceMappingURL=push.d.ts.map