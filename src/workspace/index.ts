/**
 * Barril PUBLIC do modulo de workspace.
 *
 * O entrypoint real (`src/application.ts`) usa:
 *   - `REQUIRED_ADDITIONAL_MIGRATIONS` (ou workspaceMigrations/lockingMigrations);
 *   - `createWorkspaceStack({ definitions })` como unico ToolModule;
 *   - `createWorkspaceRuntime` + `workspaceToolModule`/`lockingToolModule`/
 *     `checkpointToolModule` para composicao manual.
 *
 * Nenhuma factory/tool registra roots arbitrarios: `definitions` vem SOMENTE
 * da configuracao do servidor. `WorkspaceCatalog` implementa o
 * `WorkspaceDirectory` exigido por `collaborationToolModule`.
 */
export * from "./types.js";
export * from "./authorization.js";
export * from "./catalog.js";
export * from "./paths.js";
export * from "./content.js";
export * from "./rows.js";
export * from "./files.js";
export * from "./versions.js";
export * from "./mutations.js";
export * from "./checkpoints.js";
export * from "./runtime.js";
export * from "./toolSupport.js";
export * from "./toolModule.js";
export * from "./migrations/010_workspace.js";
export { lockingMigrations } from "../locking/migrations/020_locking.js";
export * from "./stack.js";
