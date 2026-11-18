import { randomUUID } from "node:crypto";
import type { PrincipalId, WorkspaceId } from "../contracts/index.js";
import type { DatabaseConnection } from "../persistence/index.js";
import type { WorkspaceDirectory } from "../collaboration/index.js";
import {
  createWorkspaceAuthorization,
  workspaceAccessDeniedError,
  type WorkspaceAuthorization,
} from "./authorization.js";
import type {
  WorkspaceDefinition,
  WorkspaceRoot,
  WorkspaceSummary,
} from "./types.js";

/**
 * Catalogo PERSISTENTE de workspaces permitidos + autorizacao por principal.
 *
 * - Configurado SOMENTE no servidor por `definitions` (ou por uma politica
 *   compartilhada criada em `startApplication`). NAO existe tool remota para
 *   registrar roots ou `allowedPrincipals`.
 * - `rootPath`/`realRoot` NUNCA aparecem em respostas, eventos ou auditoria:
 *   ficam apenas em memoria (na politica) e no espelho `ws_catalog` do SQLite.
 * - `createWorkspaceCatalog` e SINCRONA, idempotente e usa o `db` compartilhado
 *   (nao reabre o arquivo). Pode ser chamada por sessao HTTP sem custo.
 * - Implementa `WorkspaceDirectory` (colaboracao) via `workspaceExists` e
 *   `principalCanAccess`.
 *
 * AUTORIZACAO: quando `options.authorization` e informada, o catalogo usa a
 * MESMA instancia compartilhada por todas as sessoes (criada uma vez no
 * `startApplication`). Assim `WorkspaceAuthorization.replace()` — revalidacao
 * de `workspaces.json` — passa a valer na PROXIMA chamada de qualquer sessao,
 * inclusive as ja abertas, sem reiniciar o servidor. Quando omitida (fixtures
 * de servico), o catalogo cria uma politica LOCAL a partir das definitions.
 */
export interface WorkspaceCatalog extends WorkspaceDirectory {
  workspaceExists(workspaceId: WorkspaceId): boolean;
  /** Delegado a politica: lista EXATA, fail-closed. */
  principalCanAccess(workspaceId: WorkspaceId, principalId: PrincipalId): boolean;
  /** Lanca FORBIDDEN generico quando o principal nao esta autorizado. */
  assertPrincipalAllowed(workspaceId: WorkspaceId, principalId: PrincipalId): void;
  /** Metadados SEGUROS (id/name) de TODOS os workspaces (uso interno). */
  listSafe(): readonly WorkspaceSummary[];
  /** Metadados SEGUROS apenas dos workspaces autorizados ao principal. */
  listSafeForPrincipal(principalId: PrincipalId): readonly WorkspaceSummary[];
  /** Resolucao INTERNA do root real. NUNCA serializar em respostas. */
  resolve(workspaceId: WorkspaceId): WorkspaceRoot | undefined;
  /** Politica compartilhada (revalidacao/operador). NUNCA exponha via tool. */
  readonly authorization: WorkspaceAuthorization;
  readonly size: number;
}

export interface CreateWorkspaceCatalogOptions {
  readonly now?: () => Date;
  /** Politica compartilhada; omitida => criada localmente das definitions. */
  readonly authorization?: WorkspaceAuthorization;
}

/**
 * Cria (ou atualiza o espelho) no `db` compartilhado e devolve a instancia.
 * Idempotente: `INSERT ... ON CONFLICT DO UPDATE`, em uma unica transacao.
 */
export function createWorkspaceCatalog(
  db: DatabaseConnection,
  definitions: readonly WorkspaceDefinition[],
  options: CreateWorkspaceCatalogOptions = {},
): WorkspaceCatalog {
  const authorization =
    options.authorization ?? createWorkspaceAuthorization(definitions);
  const now = options.now ?? ((): Date => new Date());
  const createdAt = now().toISOString();

  db.transaction(() => {
    for (const entry of authorization.entries()) {
      db.prepare(
        `INSERT INTO ws_catalog (id, name, root_path, root_realpath, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           root_path = excluded.root_path,
           root_realpath = excluded.root_realpath`,
      ).run(entry.id, entry.name, entry.rootPath, entry.realRoot, createdAt);
    }
  });

  const catalog: WorkspaceCatalog = {
    get size(): number {
      return authorization.size;
    },
    authorization,
    workspaceExists(workspaceId): boolean {
      return authorization.workspaceExists(workspaceId);
    },
    principalCanAccess(workspaceId, principalId): boolean {
      return authorization.isAllowed(workspaceId, principalId);
    },
    assertPrincipalAllowed(workspaceId, principalId): void {
      if (!authorization.isAllowed(workspaceId, principalId)) {
        throw workspaceAccessDeniedError();
      }
    },
    listSafe(): readonly WorkspaceSummary[] {
      return authorization.listSafe();
    },
    listSafeForPrincipal(principalId): readonly WorkspaceSummary[] {
      return authorization.listSafeForPrincipal(principalId);
    },
    resolve(workspaceId): WorkspaceRoot | undefined {
      return authorization.resolveRoot(workspaceId);
    },
  };
  return catalog;
}

/** Gerador opaco de IDs locais (sem significado de fornecedor). */
export function newWorkspaceObjectId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
