import type { Migration } from "../types.js";

/**
 * Migration 001 — infraestrutura da fundacao.
 *
 * Cria APENAS `app_metadata` (chave/valor leve para estado operacional do
 * servidor). Nenhuma tabela de dominio (salas, mensagens, tarefas, locks,
 * versoes, auditoria) e criada aqui: isso pertence aos modulos posteriores,
 * que registram suas proprias migrations.
 */
export const foundationMigration: Migration = {
  version: 1,
  name: "001_foundation_app_metadata",
  up(db): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_metadata (
        key         TEXT PRIMARY KEY NOT NULL,
        value       TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);
  },
};

export const foundationMigrations: readonly Migration[] = [foundationMigration] as const;
