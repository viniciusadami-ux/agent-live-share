import type { Migration } from "../types.js";

/**
 * Migration 030 — autenticacao/autorizacao de TRANSPORTE.
 *
 * Cria `transport_principals` (uma credencial por pessoa/cliente/instalacao)
 * e vincula cada sessao de colaboracao ao principal que a criou.
 *
 * Regras:
 * - `token_hash` e UNIQUE e guarda SOMENTE SHA-256 hexadecimal do Bearer
 *   token. O texto puro nunca e persistido, logado ou retornado fora do CLI
 *   de criacao.
 * - `status` permite revogacao imediata: toda requisicao consulta o banco,
 *   sem cache de credenciais.
 * - `collab_sessions.principal_id` e NULL para sessoes LEGADAS (DB v20). Elas
 *   permanecem no banco (dados preservados), mas ficam inacessiveis via
 *   transporte autenticado: nao ha como provar a que principal pertenciam.
 * - O `ALTER TABLE` e CONDICIONAL: a migration 030 tambem precisa funcionar
 *   em bancos que nao possuem `collab_sessions` (fundacao isolada). Nao ha
 *   `ADD COLUMN IF NOT EXISTS` em SQLite, entao consultamos `table_info`.
 *
 * Nenhuma migration anterior e alterada.
 */
export const transportAuthMigration: Migration = {
  version: 30,
  name: "030_transport_principals_and_session_binding",
  up(db): void {
    db.exec(`
      CREATE TABLE transport_principals (
        id          TEXT PRIMARY KEY NOT NULL,
        name        TEXT NOT NULL,
        token_hash  TEXT NOT NULL UNIQUE,
        status      TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at  TEXT NOT NULL,
        revoked_at  TEXT
      );
      CREATE INDEX transport_principals_status_idx ON transport_principals(status);
    `);

    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("collab_sessions");
    if (table === undefined) return;

    const columns = db.prepare("PRAGMA table_info(collab_sessions)").all();
    const hasPrincipalId = columns.some((column) => column["name"] === "principal_id");
    if (!hasPrincipalId) {
      db.exec("ALTER TABLE collab_sessions ADD COLUMN principal_id TEXT;");
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS collab_sessions_principal_idx
        ON collab_sessions(principal_id);
    `);
  },
};

export const transportAuthMigrations: readonly Migration[] = [transportAuthMigration] as const;
