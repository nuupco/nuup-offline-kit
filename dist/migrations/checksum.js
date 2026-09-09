"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checksum = checksum;
exports.checksumStatements = checksumStatements;
// Deterministic djb2 hash, no crypto dependency needed (RN has no consistent crypto.subtle).
// Not for security — only to detect that an already-applied migration's statements changed.
function checksum(input) {
    let hash = 5381;
    for (let i = 0; i < input.length; i += 1) {
        hash = (hash * 33) ^ input.charCodeAt(i);
    }
    return (hash >>> 0).toString(16);
}
function checksumStatements(statements) {
    return checksum(JSON.stringify(statements));
}
//# sourceMappingURL=checksum.js.map