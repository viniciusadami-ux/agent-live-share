import type { DatabaseConnection } from "./types.js";

/**
 * Acesso a `app_metadata` (criada pela migration 001).
 * Estado operacional leve; nao substitui as tabelas de dominio futuras.
 */
export function getMetadata(db: DatabaseConnection, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM app_metadata WHERE key = ?").get(key);
  return row === undefined ? undefined : String(row["value"]);
}

export function setMetadata(db: DatabaseConnection, key: string, value: string): void {
  db.prepare(
    `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, new Date().toISOString());
}
