/**
 * Barril do modulo de colaboracao.
 *
 * Consumidores externos:
 * - `authenticateCollaborationSession(db, token, options?)` para autenticar
 *   sessoes de agente (modulo de workspace/locking);
 * - `collaborationMigrations` na composicao de `startServer`;
 * - `collaborationToolModule({ workspaceDirectory })` para registrar as tools;
 * - tipos publicos de ator, sala, mensagem, tarefa e handoff.
 */
export * from "./types.js";
export * from "./workspace.js";
export * from "./tokens.js";
export * from "./auth.js";
export * from "./service.js";
export * from "./toolModule.js";
export * from "./tools.js";
export * from "./migrations/002_collaboration.js";
export type { CollaborationRuntime } from "./context.js";
export { evaluateHandoffSufficiency } from "./handoffs.js";
export {
  appendEvent,
  readAuthorizedUpdates,
  recordAudit,
  safeRecordAudit,
} from "./events.js";
export type { AppendEventInput, AppendedEvent, AuditInput } from "./events.js";
