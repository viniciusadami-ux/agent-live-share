import { renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { PrincipalId } from "../contracts/index.js";
import type { DatabaseConnection } from "../persistence/index.js";
import { createWorkspaceCatalog, type WorkspaceCatalog } from "./catalog.js";
import type { WorkspaceAuthorization } from "./authorization.js";
import {
  DEFAULT_WORKSPACE_LIMITS,
  type WorkspaceDefinition,
  type WorkspaceLimits,
} from "./types.js";
import { recoverPendingWrites } from "./versions.js";

/**
 * Porta de ESCRITA do filesystem, injetavel para simular falhas em testes.
 * Cobre apenas o passo mutavel (temp + rename + limpeza); leituras e validacao
 * de caminho usam `node:fs` diretamente (estado real do disco).
 */
export interface MutationFileSystem {
  /** Grava bytes em arquivo temporario NO MESMO DIRETORIO do destino (flag wx). */
  writeTemp(targetAbsolute: string, tempName: string, content: Uint8Array): string;
  /** Substitui atomically o destino pelo temporario (rename no mesmo volume). */
  replace(tempAbsolute: string, targetAbsolute: string): void;
  /** Remove temporario (best-effort, nunca lanca). */
  cleanup(tempAbsolute: string): void;
}

export const realMutationFileSystem: MutationFileSystem = {
  writeTemp(targetAbsolute, tempName, content): string {
    const tempAbsolute = path.join(path.dirname(targetAbsolute), tempName);
    writeFileSync(tempAbsolute, content, { flag: "wx" });
    return tempAbsolute;
  },
  replace(tempAbsolute, targetAbsolute): void {
    // Node usa MoveFileExW com MOVEFILE_REPLACE_EXISTING no Windows:
    // substitui o arquivo existente de forma atomica no mesmo volume.
    renameSync(tempAbsolute, targetAbsolute);
  },
  cleanup(tempAbsolute): void {
    try {
      rmSync(tempAbsolute, { force: true });
    } catch {
      // limpeza best-effort
    }
  },
};

export interface WorkspaceRuntime {
  readonly db: DatabaseConnection;
  readonly catalog: WorkspaceCatalog;
  readonly now: () => Date;
  readonly limits: WorkspaceLimits;
  readonly fs: MutationFileSystem;
  /** Principal da sessao MCP; usado por `withActor` ao autenticar a sessao de sala. */
  readonly principalId: PrincipalId;
}

export interface CreateWorkspaceRuntimeOptions {
  readonly definitions: readonly WorkspaceDefinition[];
  readonly now?: () => Date;
  /** Limites parciais; os nao informados usam DEFAULT_WORKSPACE_LIMITS. */
  readonly limits?: Partial<WorkspaceLimits>;
  /** Injetavel para testes de falha de filesystem. */
  readonly fs?: MutationFileSystem;
  readonly catalogNow?: () => Date;
  /** OBRIGATORIO: identidade de transporte, nunca aceita do modelo. */
  readonly principalId: PrincipalId;
  /**
   * Politica COMPARTILHADA de autorizacao por workspace. Omitida => o catalogo
   * cria uma politica local a partir de `definitions` (fixtures de servico).
   * Em producao `createWorkspaceStack`/`startApplication` sempre injetam a
   * instancia unica, para que revalidacao de config valha em todas as sessoes.
   */
  readonly authorization?: WorkspaceAuthorization;
}

/** Valida e mescla limites, rejeitando valores nao positivos. */
function resolveLimits(partial: Partial<WorkspaceLimits> | undefined): WorkspaceLimits {
  const merged: WorkspaceLimits = { ...DEFAULT_WORKSPACE_LIMITS, ...(partial ?? {}) };
  for (const [key, value] of Object.entries(merged)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value <= 0)) {
      throw new RangeError(`Limite "${key}" precisa ser um numero positivo.`);
    }
  }
  return merged;
}

/**
 * Constroi o runtime compartilhado (catalogo + servicos) a partir do `db`
 * ja aberto. SINCRONA e idempotente: nao reabre o SQLite; apenas usa a conexao
 * compartilhada recebida. Pode ser chamada por sessao HTTP (o estado real
 * continua no SQLite + filesystem).
 *
 * `recoverPendingWrites` roda aqui para finalizar/limpar journals de uma
 * execucao anterior que tenha sido interrompida entre a gravacao em disco e
 * o registro da versao (recuperacao conservadora, veja versions.ts).
 */
export function createWorkspaceRuntime(
  db: DatabaseConnection,
  options: CreateWorkspaceRuntimeOptions,
): WorkspaceRuntime {
  const now = options.now ?? ((): Date => new Date());
  const catalog = createWorkspaceCatalog(db, options.definitions, {
    now: options.catalogNow ?? now,
    ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
  });
  const runtime: WorkspaceRuntime = {
    db,
    catalog,
    now,
    limits: resolveLimits(options.limits),
    fs: options.fs ?? realMutationFileSystem,
    principalId: options.principalId,
  };
  recoverPendingWrites(runtime);
  return runtime;
}
