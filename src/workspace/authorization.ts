import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import {
  asWorkspaceId,
  DomainError,
  isPrincipalIdFormat,
  type PrincipalId,
  type WorkspaceId,
} from "../contracts/index.js";
import type {
  WorkspaceDefinition,
  WorkspaceRoot,
  WorkspaceSummary,
} from "./types.js";

/**
 * POLITICA DE AUTORIZACAO POR WORKSPACE (rodada 2 / escopo de transporte).
 *
 * Esta e a UNICA fonte de verdade sobre "qual principal pode usar qual
 * workspace". Ela e construida SOMENTE a partir de `definitions` do servidor
 * (`workspaces.json` / `startApplication({ definitions })`). Nenhuma tool,
 * argumento de modelo, mensagem, convite ou tabela editavel remotamente pode
 * altera-la.
 *
 * Propriedades:
 * - FAIL-CLOSED: `allowedPrincipals` ausente/vazio => nenhum principal
 *   autorizado; nao existe wildcard nem "permitir todos".
 * - Lista EXATA de `PrincipalId` (`prin_...`), validada no startup (formato,
 *   duplicatas, nao-vazamento de tokens). Nao consultamos a existencia da
 *   credencial: ela pode ser emitida depois pelo CLI `auth:create`.
 * - COMPARTILHADA: `startApplication` cria UMA instancia e a passa ao
 *   `createWorkspaceStack`; todos os `WorkspaceCatalog`/sessoes MCP delegam a
 *   ela. `replace()` (revalidacao de config, equivalente a reiniciar com novo
 *   `workspaces.json`) altera a politica para TODAS as sessoes na PROXIMA
 *   chamada, inclusive sessoes ja existentes.
 * - A politica guarda roots ja canonicalizados (nunca serializados em resposta)
 *   para que `workspaceExists`/`resolveRoot` e a autorizacao nao divergam apos
 *   um `replace()`.
 *
 * Nenhuma migration: a lista de principals e CONFIGURACAO, mantida em memoria.
 * Nao existe tabela com allowed lists acessivel por tool (secao 6 da missao).
 * A migration 030 permanece intacta; v40 fica reservada para evolucao futura.
 */

export interface WorkspaceAuthorizationEntry {
  readonly id: WorkspaceId;
  readonly name: string;
  /** Caminho absoluto do host: INTERNO, nunca serializado. */
  readonly rootPath: string;
  /** Root canonicalizado (realpath): INTERNO, nunca serializado. */
  readonly realRoot: string;
  /** Conjunto IMUTAVEL de PrincipalIds autorizados. Vazio = fail-closed. */
  readonly allowedPrincipals: ReadonlySet<string>;
}

export interface WorkspaceAuthorization {
  isAllowed(workspaceId: WorkspaceId, principalId: PrincipalId): boolean;
  /** Lanca FORBIDDEN generico (sem enumerar principals/workspaces). */
  assertAllowed(workspaceId: WorkspaceId, principalId: PrincipalId): void;
  workspaceExists(workspaceId: WorkspaceId): boolean;
  resolveRoot(workspaceId: WorkspaceId): WorkspaceRoot | undefined;
  /** Metadados SEGUROS de TODOS os workspaces (uso interno/auditoria). */
  listSafe(): readonly WorkspaceSummary[];
  /** Metadados SEGUROS apenas dos workspaces autorizados ao principal. */
  listSafeForPrincipal(principalId: PrincipalId): readonly WorkspaceSummary[];
  /** Snapshot interno para o espelho duravel `ws_catalog`. */
  entries(): readonly WorkspaceAuthorizationEntry[];
  /**
   * Revalida a politica a partir de novas definitions (operator reload).
   * Valida TUDO de novo (IDs, formato de principals, roots, sobreposicao)
   * antes de trocar o estado; em caso de erro, a politica anterior permanece.
   */
  replace(definitions: readonly WorkspaceDefinition[]): void;
  readonly size: number;
}

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_WORKSPACE_ID_LENGTH = 200;
const MAX_WORKSPACE_NAME_LENGTH = 120;

function invalidDefinition(message: string, hint: string): DomainError {
  return new DomainError("VALIDATION_FAILED", message, { hint });
}

export function validateWorkspaceId(raw: string): WorkspaceId {
  const id = raw.trim();
  if (
    id.length === 0 ||
    id.length > MAX_WORKSPACE_ID_LENGTH ||
    id.includes("..") ||
    id.includes("/") ||
    id.includes("\\") ||
    /\s/.test(id) ||
    !WORKSPACE_ID_PATTERN.test(id)
  ) {
    throw invalidDefinition(
      `Definicao de workspace invalida: id "${raw}" nao e um identificador opaco.`,
      "Use apenas letras/numeros e . _ : - (ex.: migracao-2026). Caminhos do host nunca sao aceitos como id.",
    );
  }
  return asWorkspaceId(id);
}

/**
 * Valida `allowedPrincipals`. Ausente/null => [] (fail-closed, NAO erro).
 * Itens invalidos (nome, displayName, token Bearer, caminho, curinga, formato
 * errado) e duplicatas dentro da lista => erro (falha alto no startup).
 * Nunca loga tokens: aqui so existem IDs opacos.
 */
export function normalizeAllowedPrincipals(
  raw: unknown,
  workspaceId: string,
): readonly PrincipalId[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw invalidDefinition(
      `allowedPrincipals de "${workspaceId}" precisa ser um array de IDs de principal.`,
      'Use ["prin_<uuid>", ...]. Campo ausente/vazio = nenhum principal autorizado (fail closed). Nao ha wildcard.',
    );
  }
  const seen = new Set<string>();
  const result: PrincipalId[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !isPrincipalIdFormat(item)) {
      throw invalidDefinition(
        `allowedPrincipals de "${workspaceId}" contem um PrincipalId invalido.`,
        'Cada item deve ser um ID opaco "prin_..." (nao nome, displayName, token Bearer, caminho ou curinga).',
      );
    }
    if (seen.has(item)) {
      throw invalidDefinition(
        `allowedPrincipals de "${workspaceId}" contem PrincipalId duplicado.`,
        "Remova a duplicata: a autorizacao e uma lista exata e sem repeticao.",
      );
    }
    seen.add(item);
    result.push(item as PrincipalId);
  }
  return result;
}

function foldForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

/** `child` esta contido em `root` (igual ou descendente). */
function containsRoot(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  const folded = foldForCompare(relative);
  return folded !== ".." && !folded.startsWith(".." + path.sep);
}

/**
 * Roots iguais/sobrepostos anulariam a exclusividade de locks (chaves
 * workspace_id + path_key diferentes para o mesmo arquivo real).
 */
function assertRootsDoNotOverlap(
  roots: readonly { id: string; realRoot: string }[],
): void {
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      const first = roots[i];
      const second = roots[j];
      if (first === undefined || second === undefined) continue;
      if (
        containsRoot(first.realRoot, second.realRoot) ||
        containsRoot(second.realRoot, first.realRoot)
      ) {
        throw invalidDefinition(
          `Workspaces "${first.id}" e "${second.id}" apontam para roots iguais ou sobrepostos.`,
          "Cada workspace deve apontar para uma arvore de diretorios distinta; locks sao por workspace.",
        );
      }
    }
  }
}

function canonicalizeRoot(rootPath: string): { rootPath: string; realRoot: string } {
  if (typeof rootPath !== "string" || rootPath.trim().length === 0) {
    throw invalidDefinition(
      "Definicao de workspace sem rootPath.",
      "Informe um caminho absoluto de um diretorio existente no host (configuracao do servidor).",
    );
  }
  const absolute = path.resolve(rootPath.trim());
  let stats;
  try {
    stats = statSync(absolute);
  } catch (error) {
    throw new DomainError("INTERNAL", "rootPath do workspace nao existe ou nao e acessivel.", {
      hint: "Verifique a configuracao do servidor: o diretorio precisa existir no host.",
      cause: error,
    });
  }
  if (!stats.isDirectory()) {
    throw invalidDefinition(
      "rootPath do workspace nao e um diretorio.",
      "Aponte para um diretorio real no host, nao para um arquivo.",
    );
  }
  let realRoot: string;
  try {
    realRoot = realpathSync.native(absolute);
  } catch (error) {
    throw new DomainError("INTERNAL", "Falha ao canonicalizar rootPath do workspace.", {
      hint: "Verifique permissoes do diretorio no host.",
      cause: error,
    });
  }
  return { rootPath: absolute, realRoot };
}

/** Constroi (e valida) o conjunto de entradas a partir das definitions. */
export function buildAuthorizationEntries(
  definitions: readonly WorkspaceDefinition[],
): readonly WorkspaceAuthorizationEntry[] {
  if (!Array.isArray(definitions)) {
    throw new TypeError("createWorkspaceAuthorization exige um array de definitions.");
  }
  const entries: WorkspaceAuthorizationEntry[] = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (definition === null || typeof definition !== "object") {
      throw invalidDefinition(
        "Definicao de workspace invalida (nao objeto).",
        "Passe {id,name,rootPath,allowedPrincipals?}.",
      );
    }
    const id = validateWorkspaceId(String(definition.id ?? ""));
    const key = String(id);
    if (seen.has(key)) {
      throw invalidDefinition(
        `Workspace duplicado nas definitions: "${key}".`,
        "Cada workspace deve ter um id unico.",
      );
    }
    seen.add(key);
    const name = String(definition.name ?? "").trim();
    if (name.length === 0 || name.length > MAX_WORKSPACE_NAME_LENGTH) {
      throw invalidDefinition(
        `Nome invalido para o workspace "${key}".`,
        `Use um nome de 1 a ${MAX_WORKSPACE_NAME_LENGTH} caracteres.`,
      );
    }
    const allowed = normalizeAllowedPrincipals(definition.allowedPrincipals, key);
    const { rootPath, realRoot } = canonicalizeRoot(String(definition.rootPath ?? ""));
    entries.push({
      id,
      name,
      rootPath,
      realRoot,
      allowedPrincipals: new Set(allowed.map(String)),
    });
  }
  assertRootsDoNotOverlap(entries);
  return entries;
}

/**
 * Erro de autorizacao GENERICO: nao revela se o workspace existe, quais
 * principals existem, nem a lista completa. Usado por todas as camadas.
 */
export function workspaceAccessDeniedError(): DomainError {
  return new DomainError(
    "FORBIDDEN",
    "Principal nao autorizado para este workspace.",
    {
      hint:
        "Confirme o workspaceId com o operador ou use collab_list_workspaces. Se o id estiver correto, " +
        "solicite ao operador para incluir o id da sua credencial em allowedPrincipals do workspace " +
        "(workspaces.json) e revalidar a configuracao. Convites nao ampliam esse acesso.",
    },
  );
}

export function createWorkspaceAuthorization(
  definitions: readonly WorkspaceDefinition[],
): WorkspaceAuthorization {
  // Validacao completa ANTES de publicar qualquer estado.
  let current = buildAuthorizationEntries(definitions);
  let index = new Map<string, WorkspaceAuthorizationEntry>(
    current.map((entry) => [String(entry.id), entry]),
  );

  const api: WorkspaceAuthorization = {
    get size(): number {
      return index.size;
    },
    isAllowed(workspaceId, principalId): boolean {
      const entry = index.get(String(workspaceId));
      if (entry === undefined) return false; // workspace inexistente => negado
      return entry.allowedPrincipals.has(String(principalId));
    },
    assertAllowed(workspaceId, principalId): void {
      if (!api.isAllowed(workspaceId, principalId)) {
        throw workspaceAccessDeniedError();
      }
    },
    workspaceExists(workspaceId): boolean {
      return index.has(String(workspaceId));
    },
    resolveRoot(workspaceId): WorkspaceRoot | undefined {
      const entry = index.get(String(workspaceId));
      return entry === undefined
        ? undefined
        : { id: entry.id, name: entry.name, realRoot: entry.realRoot };
    },
    listSafe(): readonly WorkspaceSummary[] {
      return [...index.values()]
        .map((entry) => ({ id: entry.id, name: entry.name }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    },
    listSafeForPrincipal(principalId): readonly WorkspaceSummary[] {
      const key = String(principalId);
      return [...index.values()]
        .filter((entry) => entry.allowedPrincipals.has(key))
        .map((entry) => ({ id: entry.id, name: entry.name }))
        .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    },
    entries(): readonly WorkspaceAuthorizationEntry[] {
      return current;
    },
    replace(nextDefinitions): void {
      // build valida TUDO; se falhar, `current`/`index` permanecem intactos.
      const next = buildAuthorizationEntries(nextDefinitions);
      current = next;
      index = new Map<string, WorkspaceAuthorizationEntry>(
        next.map((entry) => [String(entry.id), entry]),
      );
    },
  };
  return api;
}
