import type { PrincipalId } from "./ids.js";

/**
 * Identidade de TRANSPORTE (principal): uma credencial por pessoa/cliente/
 * instalacao. NAO e uma sala, NAO e um agente e NAO e uma sessao de sala.
 *
 * Distincao importante:
 * - `AuthenticatedPrincipal` vem do `Authorization: Bearer` e e validado no
 *   middleware HTTP. Identifica QUEM esta conectado ao servidor MCP.
 * - `sessionToken` de colaboracao (`collab_create_room` / `collab_join_room`)
 *   identifica o ATOR dentro de uma sala e e sempre vinculado ao principal
 *   que o criou (migration 030). Um principal pode criar/entrar em varias salas.
 *
 * Nenhum token em claro ou hash aparece nestes tipos.
 */
export type PrincipalStatus = "active" | "revoked";

export interface AuthenticatedPrincipal {
  readonly id: PrincipalId;
  readonly name: string;
}

/** Visao administrativa SEGURA para CLI/health: nunca contem token ou hash. */
export interface PrincipalView {
  readonly id: PrincipalId;
  readonly name: string;
  readonly status: PrincipalStatus;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

/**
 * Modo de autenticacao do `startServer` (fundacao de baixo nivel).
 * `startApplication`/entrypoint de producao usam SEMPRE "required".
 */
export type TransportAuthMode = "required" | "disabled-for-tests";

/**
 * Formato de `PrincipalId` usado em `allowedPrincipals` (workspaces.json).
 *
 * Os IDs reais sao gerados por `createPrincipal` como `prin_<uuid>`. A lista
 * de configuracao e validada no STARTUP contra este formato: entradas que nao
 * sejam IDs opacos (nomes, displayName, tokens Bearer, caminhos, curingas)
 * falham alto. NAO ha wildcard: a autorizacao e sempre uma lista EXATA.
 *
 * `isPrincipalIdFormat` valida APENAS o formato, nunca a existencia da
 * credencial no banco (ela pode ser emitida depois pelo CLI).
 */
export const PRINCIPAL_ID_PATTERN = /^prin_[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const MAX_PRINCIPAL_ID_LENGTH = 200;

export function isPrincipalIdFormat(value: string): boolean {
  return (
    value.length <= MAX_PRINCIPAL_ID_LENGTH &&
    !value.includes("..") &&
    PRINCIPAL_ID_PATTERN.test(value)
  );
}
