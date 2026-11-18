import type { Migration } from "../persistence/index.js";
import type { ToolModule, ToolContext } from "../server/composition.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  collaborationMigrations,
  collaborationToolModule,
} from "../collaboration/index.js";
import { workspaceMigrations } from "./migrations/010_workspace.js";
import { lockingMigrations } from "../locking/migrations/020_locking.js";
import { createWorkspaceRuntime, type MutationFileSystem } from "./runtime.js";
import {
  createWorkspaceAuthorization,
  type WorkspaceAuthorization,
} from "./authorization.js";
import { workspaceToolModule, checkpointToolModule } from "./toolModule.js";
import { lockingToolModule } from "../locking/toolModule.js";
import type { WorkspaceLimits, WorkspaceDefinition } from "./types.js";

/**
 * PONTO DE COMPOSICAO UNICO.
 *
 * O entrypoint real usa `startApplication` (`src/application.ts`), que passa
 * `REQUIRED_ADDITIONAL_MIGRATIONS` e este ToolModule ao `startServer`.
 *
 * Ordem EXATA das migrations em `startServer({ additionalMigrations })`:
 *   [ ...collaborationMigrations (v2),
 *     ...workspaceMigrations      (v10),
 *     ...lockingMigrations        (v20) ]
 * A fundacao (v1) e prependida automaticamente por `startServer`.
 * `REQUIRED_ADDITIONAL_MIGRATIONS` ja e esse array, na ordem correta.
 */
export const REQUIRED_ADDITIONAL_MIGRATIONS: readonly Migration[] = [
  ...collaborationMigrations,
  ...workspaceMigrations,
  ...lockingMigrations,
] as const;

export interface WorkspaceStackOptions {
  /** Definicoes allowlisted SOMENTE no servidor: {id,name,rootPath}. */
  readonly definitions: readonly WorkspaceDefinition[];
  /** Relogio injetavel (compartilhado com colaboracao, locks e checkpoints). */
  readonly now?: () => Date;
  readonly catalogNow?: () => Date;
  readonly limits?: Partial<WorkspaceLimits>;
  /** Injetavel para testes de falha de filesystem. */
  readonly fs?: MutationFileSystem;
  readonly sessionTtlMs?: number;
  readonly inviteTtlMs?: number;
  /**
   * Politica COMPARTILHADA de autorizacao por workspace. `startApplication`
   * sempre injeta a instancia unica (para revalidacao valer em todas as
   * sessoes). Omitida => criada UMA vez aqui, no escopo externo deste factory,
   * e compartilhada por todas as sessoes deste stack.
   */
  readonly authorization?: WorkspaceAuthorization;
  /**
   * false = NAO registrar as tools de colaboracao (integrador as registra
   * separadamente com `collaborationToolModule({ workspaceDirectory })`).
   * Padrao true.
   */
  readonly includeCollaboration?: boolean;
}

/**
 * `ToolModule` COMPOSTO: por sessao HTTP cria o catalogo no `ctx.db`
 * compartilhado e liga colaboracao + workspace + locking + checkpoints.
 *
 * Toda inicializacao e SINCRONA e idempotente (nao reabre o SQLite). O catalogo
 * e um `WorkspaceDirectory` real e passado ao `collaborationToolModule`, entao
 * `collab_create_room` passa a validar o workspace contra o catalogo persistido.
 */
export function createWorkspaceStack(options: WorkspaceStackOptions): ToolModule {
  if (!Array.isArray(options.definitions)) {
    throw new TypeError("createWorkspaceStack exige definitions (array).");
  }
  // Executa UMA vez (no startup/composicao), NAO por sessao HTTP: a politica
  // e compartilhada para que `replace()` (revalidacao de config) atinga todas
  // as sessoes na proxima chamada. Validacao fail-fast de roots/IDs ocorre aqui.
  const authorization =
    options.authorization ?? createWorkspaceAuthorization(options.definitions);

  return (server: McpServer, context: ToolContext): void => {
    // Identidade vem EXCLUSIVAMENTE do contexto autenticado da sessao MCP.
    const principalId = context.authenticatedPrincipal.id;
    const runtime = createWorkspaceRuntime(context.db, {
      definitions: options.definitions,
      now: options.now,
      catalogNow: options.catalogNow,
      limits: options.limits,
      fs: options.fs,
      principalId,
      authorization,
    });

    if (options.includeCollaboration !== false) {
      collaborationToolModule({
        workspaceDirectory: runtime.catalog,
        now: options.now,
        sessionTtlMs: options.sessionTtlMs,
        inviteTtlMs: options.inviteTtlMs,
        principalId,
      })(server, context);
    }

    workspaceToolModule(runtime)(server, context);
    lockingToolModule(runtime)(server, context);
    checkpointToolModule(runtime)(server, context);
  };
}
