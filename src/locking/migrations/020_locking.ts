import type { Migration } from "../../persistence/index.js";

/**
 * Migration 020 — locking: locks exclusivos por arquivo.
 *
 * A exclusividade e GLOBAL POR WORKSPACE (nao por sala): duas salas diferentes
 * apontando para o mesmo `workspace_id` disputam o mesmo arquivo. Por isso a
 * chave do indice e `(workspace_id, path_key)`, SEM room_id.
 *
 * `file_locks_one_active_per_path_idx` e um indice UNIQUE PARCIAL sobre
 * `status = 'held'`. Ele e o BACKSTOP atomico: mesmo que duas aquisicoes
 * cheguem "ao mesmo tempo", apenas um INSERT 'held' sobrevive. A expiracao
 * lazy (UPDATE ... SET status = 'expired') roda ANTES de cada aquisicao,
 * dentro da mesma transacao, para que um lock abandonado nao bloqueie o
 * indice para sempre.
 *
 * `path_key` e a forma estavel (case-folded) do caminho normalizado; `path`
 * e o caminho relativo de exibicao. Nenhum caminho absoluto/root e gravado.
 * Nao ha FK para collaboration/workspace: IDs sao TEXT opacos e a validacao
 * de sala/tarefa acontece no servico, com consultas defensivas.
 */
export const lockingCoreMigration: Migration = {
  version: 20,
  name: "020_locking_exclusive_file_locks",
  up(db): void {
    db.exec(`
      CREATE TABLE file_locks (
        id                TEXT PRIMARY KEY NOT NULL,
        workspace_id      TEXT NOT NULL,
        path              TEXT NOT NULL,
        path_key          TEXT NOT NULL,
        room_id           TEXT NOT NULL,
        agent_id          TEXT NOT NULL,
        session_id        TEXT NOT NULL,
        task_id           TEXT,
        intent            TEXT NOT NULL,
        status            TEXT NOT NULL CHECK (status IN ('held', 'released', 'expired')),
        acquired_at       TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        expires_at        TEXT NOT NULL,
        released_at       TEXT
      );
      CREATE UNIQUE INDEX file_locks_one_active_per_path_idx
        ON file_locks(workspace_id, path_key) WHERE status = 'held';
      CREATE INDEX file_locks_workspace_status_idx
        ON file_locks(workspace_id, status, expires_at);
      CREATE INDEX file_locks_session_idx
        ON file_locks(session_id, status);
      CREATE INDEX file_locks_room_idx
        ON file_locks(room_id, status);
    `);
  },
};

export const lockingMigrations: readonly Migration[] = [lockingCoreMigration] as const;
