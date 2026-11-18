import type { PrincipalId } from "../contracts/index.js";
import type { DatabaseConnection } from "../persistence/index.js";
import type { WorkspaceDirectory } from "./workspace.js";

/**
 * Dependencias de runtime compartilhadas pelos servicos. Tudo que e estado
 * fica no SQLite; o runtime so carrega configuracao, relogio injetavel e a
 * identidade de transporte autenticada (principal), que NUNCA vem do modelo.
 */
export interface CollaborationRuntime {
  readonly db: DatabaseConnection;
  readonly workspaceDirectory: WorkspaceDirectory;
  readonly now: () => Date;
  readonly sessionTtlMs: number;
  readonly inviteTtlMs: number;
  /**
   * Principal autenticado no transporte (Bearer), congelado no ToolContext da
   * sessao MCP. Usado para autorizacao por workspace em create/join/create_invite.
   */
  readonly principalId: PrincipalId;
}
