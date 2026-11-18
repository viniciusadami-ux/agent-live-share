import type { PrincipalId } from "../contracts/index.js";
import type { ToolContext, ToolModule } from "../server/composition.js";
import {
  createCollaborationService,
  type CollaborationServiceOptions,
} from "./service.js";
import { registerCollaborationTools } from "./tools.js";
import type { WorkspaceDirectory } from "./workspace.js";

/**
 * Composicao das ferramentas de colaboracao.
 *
 * A validacao de workspace e INJETADA: o modulo nao conhece caminhos do host
 * nem cria catalogo proprio. Na composicao real o integrador passa uma
 * implementacao ligada ao catalogo de workspaces permitidos; nos testes,
 * `createStaticWorkspaceDirectory` cobre o caso.
 */
export interface CollaborationToolModuleOptions {
  readonly workspaceDirectory: WorkspaceDirectory;
  readonly now?: () => Date;
  readonly sessionTtlMs?: number;
  readonly inviteTtlMs?: number;
  /** Omitido: usa o principal autenticado do `ToolContext` da sessao. */
  readonly principalId?: PrincipalId;
}

export function collaborationToolModule(
  options: CollaborationToolModuleOptions,
): ToolModule {
  if (
    options.workspaceDirectory === undefined ||
    typeof options.workspaceDirectory.workspaceExists !== "function"
  ) {
    throw new TypeError(
      "collaborationToolModule exige um WorkspaceDirectory com workspaceExists(workspaceId).",
    );
  }
  // Fail-fast de composicao: sem o metodo de autorizacao, create/join/create_invite
  // seriam negados em runtime (fail-closed). E melhor derrubar a composicao.
  if (typeof options.workspaceDirectory.principalCanAccess !== "function") {
    throw new TypeError(
      "collaborationToolModule exige um WorkspaceDirectory com principalCanAccess(workspaceId, principalId). " +
        "Use o catalogo real (createWorkspaceCatalog) em producao.",
    );
  }

  return (server, context: ToolContext): void => {
    const serviceOptions: CollaborationServiceOptions = {
      db: context.db,
      workspaceDirectory: options.workspaceDirectory,
      now: options.now,
      sessionTtlMs: options.sessionTtlMs,
      inviteTtlMs: options.inviteTtlMs,
      principalId: options.principalId ?? context.authenticatedPrincipal.id,
    };
    const service = createCollaborationService(serviceOptions);
    registerCollaborationTools(server, service);
  };
}

/** Alias explicito para leitura da composicao. */
export const createCollaborationToolModule = collaborationToolModule;
