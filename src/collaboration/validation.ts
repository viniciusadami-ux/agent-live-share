import {
  DomainError,
  type ClientKind,
  type FileChangeKind,
  type TaskStatus,
} from "../contracts/index.js";
import type { RequestStatus, TaskAction } from "./types.js";

/**
 * Validacao semantica compartilhada. `zod` cobre formato/limites na borda MCP;
 * estas funcoes protegem chamadas diretas ao servico e normalizam texto.
 */

const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function validationError(message: string, hint: string, field?: string): DomainError {
  return new DomainError("VALIDATION_FAILED", message, {
    hint,
    ...(field === undefined ? {} : { context: { field } }),
  });
}

export function normalizeText(
  value: string,
  field: string,
  minLength: number,
  maxLength: number,
): string {
  const trimmed = value.trim();
  if (trimmed.length < minLength) {
    throw validationError(
      `Campo "${field}" precisa de pelo menos ${minLength} caractere(s).`,
      `Preencha "${field}" com conteudo real antes de tentar novamente.`,
      field,
    );
  }
  if (trimmed.length > maxLength) {
    throw validationError(
      `Campo "${field}" excede ${maxLength} caracteres.`,
      `Reduza "${field}" e tente novamente.`,
      field,
    );
  }
  return trimmed;
}

export function normalizeOptionalText(
  value: string | undefined,
  field: string,
  maxLength: number,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > maxLength) {
    throw validationError(
      `Campo "${field}" excede ${maxLength} caracteres.`,
      `Reduza "${field}" e tente novamente.`,
      field,
    );
  }
  return trimmed;
}

export function normalizeClientKind(value: string | undefined): ClientKind {
  if (value === undefined) return "generic-mcp";
  const trimmed = value.trim();
  if (trimmed.length === 0) return "generic-mcp";
  if (trimmed.length > 60) {
    throw validationError(
      'Campo "clientKind" excede 60 caracteres.',
      "Informe o nome curto do cliente MCP (ex.: opencode, codex, claude-code).",
      "clientKind",
    );
  }
  return trimmed;
}

/**
 * `workspaceId` e OPERACIONAL, nunca caminho. Rejeita separadores, `..`,
 * espacos e caracteres de controle antes mesmo de consultar o catalogo.
 */
export function normalizeWorkspaceId(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 200 ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /\s/.test(trimmed) ||
    !WORKSPACE_ID_PATTERN.test(trimmed)
  ) {
    throw validationError(
      "workspaceId invalido: use apenas um identificador operacional.",
      "O servidor nao aceita caminhos do host. Use o id de um workspace ja registrado no catalogo.",
      "workspaceId",
    );
  }
  return trimmed;
}

export function normalizeLimit(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw validationError(
      "O limite precisa ser um inteiro positivo.",
      `Use um valor entre 1 e ${max}.`,
      "limit",
    );
  }
  return Math.min(value, max);
}

export function normalizeCursor(value: string | undefined): string {
  if (value === undefined || value.trim() === "") return "0";
  const trimmed = value.trim();
  // SQLite rowid e inteiro assinado de 64 bits: no maximo 19 digitos.
  if (!/^\d+$/.test(trimmed) || trimmed.length > 19) {
    throw validationError(
      "Cursor invalido.",
      "Use o valor de nextCursor retornado por collab_get_updates, ou omita para ler desde o inicio.",
      "cursor",
    );
  }
  return trimmed;
}

export function normalizeTaskStatus(value: string): TaskStatus {
  switch (value) {
    case "proposed":
    case "accepted":
    case "in_progress":
    case "blocked":
    case "completed":
    case "cancelled":
      return value;
    default:
      throw validationError(
        `Status de tarefa desconhecido: "${value}".`,
        "Use proposed, accepted, in_progress, blocked, completed ou cancelled.",
        "status",
      );
  }
}

export function normalizeRequestStatus(value: string): RequestStatus {
  switch (value) {
    case "open":
    case "answered":
    case "closed":
      return value;
    default:
      throw validationError(
        `Status de solicitacao desconhecido: "${value}".`,
        "Use open, answered ou closed.",
        "status",
      );
  }
}
export function normalizeTaskAction(value: string): TaskAction {
  switch (value) {
    case "accept":
    case "start":
    case "block":
    case "unblock":
    case "progress":
    case "complete":
    case "cancel":
      return value;
    default:
      throw validationError(
        `Acao de tarefa desconhecida: "${value}".`,
        "Use accept, start, block, unblock, progress, complete ou cancel.",
        "action",
      );
  }
}

export function normalizeStringList(
  values: readonly string[] | undefined,
  field: string,
  maxItems: number,
  maxLength: number,
): readonly string[] {
  if (values === undefined) return [];
  if (values.length > maxItems) {
    throw validationError(
      `Campo "${field}" excede ${maxItems} itens.`,
      `Reduza a lista "${field}".`,
      field,
    );
  }
  return values.map((value) => normalizeText(value, `${field}[]`, 1, maxLength));
}

/**
 * Metadados de arquivo: caminho relativo, sem `..` e sem raiz absoluta.
 * Nenhum acesso ao filesystem acontece nesta etapa.
 */
export function normalizeDeclaredPath(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 400 ||
    trimmed.startsWith("/") ||
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.includes("\\") ||
    trimmed.split("/").includes("..")
  ) {
    throw validationError(
      'Caminho declarado invalido em "changes": use caminho relativo ao workspace, sem "..".',
      "Exemplo valido: src/login.html. Nenhum arquivo e lido nesta etapa.",
      "changes.path",
    );
  }
  return trimmed;
}

export function normalizeFileChangeKind(value: string): FileChangeKind {
  switch (value) {
    case "created":
    case "modified":
    case "deleted":
      return value;
    default:
      throw validationError(
        `Tipo de alteracao desconhecido: "${value}".`,
        "Use created, modified ou deleted em changes[].kind.",
        "changes.kind",
      );
  }
}
