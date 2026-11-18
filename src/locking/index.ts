/**
 * Barril PUBLIC do modulo de locking.
 *
 * Servicos: `acquireLock`, `renewLock`, `releaseLock`, `lockStatus`,
 * `lockList`, `lazyExpireLocks` e `assertUsableLock` (usado por TODA mutacao
 * de workspace). Tools: `lockingToolModule`. Migration: `lockingMigrations`
 * (v20). Views e limites vem do barril de workspace (`src/workspace/index.js`).
 */
export * from "./locks.js";
export * from "./toolModule.js";
export * from "./migrations/020_locking.js";
