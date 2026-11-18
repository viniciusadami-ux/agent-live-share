import { createHash, randomBytes } from "node:crypto";

/**
 * Tokens secretos de sessao e convite.
 *
 * - 32 bytes aleatorios (256 bits) codificados em base64url, com prefixo
 *   distinto para diagnostico e rejeicao barata de valores claramente alheios.
 * - O servidor persiste e consulta SOMENTE `sha256(token)` em hexadecimal.
 * - Nenhum helper deste arquivo loga ou inclui o token em mensagens de erro.
 * - O hash e comparado pela busca indexada; nao ha comparacao byte a byte de
 *   segredo em texto puro no banco.
 */

export const SESSION_TOKEN_PREFIX = "collab_s_";
export const INVITE_TOKEN_PREFIX = "collab_i_";
const SECRET_BYTES = 32;
const MAX_SECRET_LENGTH = 512;

function generateToken(prefix: string): string {
  return `${prefix}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

export function generateSessionToken(): string {
  return generateToken(SESSION_TOKEN_PREFIX);
}

export function generateInviteToken(): string {
  return generateToken(INVITE_TOKEN_PREFIX);
}

/** SHA-256 hexadecimal; usado como unica representacao persistida do segredo. */
export function hashCollaborationSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Rejeita entradas absurdas antes de hashear (limite defensivo). */
export function isPlausibleSecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_SECRET_LENGTH;
}

export function looksLikeSessionToken(value: string): boolean {
  return value.startsWith(SESSION_TOKEN_PREFIX) && isPlausibleSecret(value);
}

export function looksLikeInviteToken(value: string): boolean {
  return value.startsWith(INVITE_TOKEN_PREFIX) && isPlausibleSecret(value);
}
