import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  DomainError,
  asPrincipalId,
  type AuthenticatedPrincipal,
  type PrincipalId,
  type PrincipalView,
} from "../../contracts/index.js";
import type { DatabaseConnection, SqlRow } from "../../persistence/index.js";

/**
 * Gerenciamento LOCAL de principals/credenciais de transporte.
 *
 * - Token: 32 bytes aleatorios (256 bits), base64url, prefixo proprio.
 * - Persistimos SOMENTE `sha256(token)` em hexadecimal, com UNIQUE.
 * - Nenhuma funcao deste arquivo loga token ou hash. O token em claro e
 *   devolvido por `createPrincipal` UMA vez e impresso apenas pelo CLI.
 * - Toda requisicao consulta o banco: revogar bloqueia IMEDIATAMENTE a
 *   proxima chamada (sem cache de credenciais).
 *
 * Concorrencia com o servidor: o CLI abre o mesmo SQLite em outro processo
 * apenas para transacoes curtas. `busy_timeout` ja esta configurado em
 * `openDatabase`. Recomenda-se rodar o CLI com o servidor parado, mas escritas
 * administrativas curtas sao seguras com o lock de arquivo do SQLite.
 */

export const TRANSPORT_TOKEN_PREFIX = "collab_p_";
const SECRET_BYTES = 32;
const MAX_TOKEN_LENGTH = 512;
const MAX_NAME_LENGTH = 120;

function generateTransportToken(): string {
  return `${TRANSPORT_TOKEN_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;
}

function hashTransportToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Rejeita entradas absurdas antes de hashear, sem revelar o motivo ao cliente. */
export function isPlausibleTransportToken(value: string): boolean {
  return (
    value.startsWith(TRANSPORT_TOKEN_PREFIX) &&
    value.length > TRANSPORT_TOKEN_PREFIX.length &&
    value.length <= MAX_TOKEN_LENGTH &&
    !/\s/.test(value)
  );
}

function normalizeName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new DomainError("VALIDATION_FAILED", "Nome do principal invalido.", {
      hint: `Use de 1 a ${MAX_NAME_LENGTH} caracteres (ex.: "Vinicius / OpenCode").`,
    });
  }
  if (/[\r\n\x00-\x1f]/.test(name)) {
    throw new DomainError("VALIDATION_FAILED", "Nome do principal contem caracteres de controle.", {
      hint: "Use um nome em uma unica linha, sem caracteres de controle.",
    });
  }
  return name;
}

function toView(row: SqlRow): PrincipalView {
  const revokedAt = row["revoked_at"];
  return {
    id: asPrincipalId(String(row["id"])),
    name: String(row["name"]),
    status: String(row["status"]) === "revoked" ? "revoked" : "active",
    createdAt: String(row["created_at"]),
    ...(revokedAt === null || revokedAt === undefined
      ? {}
      : { revokedAt: String(revokedAt) }),
  };
}

export interface CreatePrincipalResult {
  readonly principal: PrincipalView;
  /** Texto puro: exibido UMA vez pelo CLI; nunca persistido. */
  readonly token: string;
}

export function createPrincipal(
  db: DatabaseConnection,
  rawName: string,
  now: () => Date = () => new Date(),
): CreatePrincipalResult {
  const name = normalizeName(rawName);
  const id = asPrincipalId(`prin_${randomUUID()}`);
  const token = generateTransportToken();
  const createdAt = now().toISOString();

  db.prepare(
    `INSERT INTO transport_principals (id, name, token_hash, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
  ).run(id, name, hashTransportToken(token), createdAt);

  return { principal: { id, name, status: "active", createdAt }, token };
}

/** NUNCA seleciona `token_hash`: listagem nao mostra token nem hash. */
export function listPrincipals(db: DatabaseConnection): readonly PrincipalView[] {
  return db
    .prepare(
      `SELECT id, name, status, created_at, revoked_at
       FROM transport_principals
       ORDER BY created_at ASC, id ASC`,
    )
    .all()
    .map(toView);
}

export function getPrincipal(
  db: DatabaseConnection,
  id: PrincipalId,
): PrincipalView | undefined {
  const row = db
    .prepare(
      `SELECT id, name, status, created_at, revoked_at
       FROM transport_principals WHERE id = ?`,
    )
    .get(id);
  return row === undefined ? undefined : toView(row);
}

export function revokePrincipal(
  db: DatabaseConnection,
  idValue: string,
  now: () => Date = () => new Date(),
): PrincipalView {
  const id = asPrincipalId(idValue.trim());
  if (id.length === 0 || id.length > 200) {
    throw new DomainError("VALIDATION_FAILED", "principalId invalido.", {
      hint: "Use o id retornado por `npm run auth:create` ou `npm run auth:list`.",
    });
  }
  const existing = getPrincipal(db, id);
  if (existing === undefined) {
    throw new DomainError("NOT_FOUND", "Principal nao encontrado.", {
      hint: "Use `npm run auth:list` para obter ids validos.",
    });
  }
  if (existing.status === "active") {
    db.prepare(
      `UPDATE transport_principals
       SET status = 'revoked', revoked_at = ?
       WHERE id = ? AND status = 'active'`,
    ).run(now().toISOString(), id);
  }
  const updated = getPrincipal(db, id);
  if (updated === undefined) {
    throw new DomainError("INTERNAL", "Principal nao encontrado apos revogacao.", {
      hint: "Verifique a integridade do SQLite e tente novamente.",
    });
  }
  return updated;
}

/** Retorna undefined para token ausente, invalido ou revogado (sem distinguir). */
export function authenticateTransportToken(
  db: DatabaseConnection,
  token: string,
): AuthenticatedPrincipal | undefined {
  if (!isPlausibleTransportToken(token)) return undefined;
  const row = db
    .prepare("SELECT id, name, status FROM transport_principals WHERE token_hash = ?")
    .get(hashTransportToken(token));
  if (row === undefined) return undefined;
  if (String(row["status"]) !== "active") return undefined;
  return {
    id: asPrincipalId(String(row["id"])),
    name: String(row["name"]),
  };
}

export function countActivePrincipals(db: DatabaseConnection): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM transport_principals WHERE status = 'active'")
    .get();
  return row === undefined ? 0 : Number(row["total"]);
}
