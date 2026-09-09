import type { MigrationStatement } from '../types';

// Deterministic djb2 hash, no crypto dependency needed (RN has no consistent crypto.subtle).
// Not for security — only to detect that an already-applied migration's statements changed.
export function checksum(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 33) ^ input.charCodeAt(i);
  }
  return (hash >>> 0).toString(16);
}

export function checksumStatements(statements: MigrationStatement[]): string {
  return checksum(JSON.stringify(statements));
}
