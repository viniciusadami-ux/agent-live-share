import type { DomainError } from "./errors.js";
import type { AgentId, Cursor, IsoDateTime } from "./ids.js";

/**
 * Tipo de cliente e METADADO (diagnostico/compatibilidade), nunca dependencia
 * da logica do nucleo. Os valores nomeados sao apenas os clientes conhecidos;
 * outros clientes MCP sao permitidos.
 */
export type ClientKind =
  | "opencode"
  | "codex"
  | "claude-code"
  | "generic-mcp"
  | (string & {});

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** Resultado explicito, sem excecoes implicitas, para os contratos de ferramentas. */
export type Result<T, E = DomainError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T, E = DomainError>(value: T): Result<T, E> {
  return { ok: true, value };
}

export function err<T = never, E = DomainError>(error: E): Result<T, E> {
  return { ok: false, error };
}

/** Pagina por cursor (polling e consulta de atualizacoes). */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: Cursor;
}

/** Carimbo comum de auditoria; `createdBy` e a identidade autenticada, nao displayName. */
export interface AuditStamp {
  readonly createdAt: IsoDateTime;
  readonly createdByAgentId: AgentId;
}
