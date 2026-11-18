import type { Migration } from "../../persistence/index.js";

/**
 * Migration 010 — workspace: catalogo, versoes/backups, journal de escrita e
 * checkpoints.
 *
 * Convencoes de seguranca desta migration:
 * - `ws_catalog.root_path` / `root_realpath` sao caminhos ABSOLUTOS DO HOST.
 *   NUNCA sao retornados em respostas MCP, eventos ou auditoria. Sao usados
 *   apenas para resolver caminhos relativos no servidor.
 * - `file_versions.content` e `file_pending_writes.*_content` guardam o
 *   conteudo INTEGRAL (BLOB) do estado anterior/novo. Isso e o BACKUP
 *   persistente: nao criamos arquivos de backup dentro do workspace (que
 *   poderiam ser listados/editados/sobrescritos pelos agentes).
 * - Nenhuma FK para tabelas de `collaboration` ou `locking`: a ordem de
 *   aplicacao das migrations (2 -> 10 -> 20) fica independente e o runner
 *   transacional da fundacao continua valido.
 * - `file_pending_writes` e um JOURNAL de recuperacao (two-phase entre SQLite
 *   e filesystem). Ele NAO e uma versao publicada: versoes so entram em
 *   `file_versions` depois que a escrita em disco foi confirmada.
 * - `UNIQUE (workspace_id, path_key, version)` torna impossivel registrar
 *   duas versoes com o mesmo numero para o mesmo arquivo.
 */
export const workspaceCoreMigration: Migration = {
  version: 10,
  name: "010_workspace_catalog_versions_checkpoints",
  up(db): void {
    db.exec(`
      CREATE TABLE ws_catalog (
        id            TEXT PRIMARY KEY NOT NULL,
        name          TEXT NOT NULL,
        root_path     TEXT NOT NULL,
        root_realpath TEXT NOT NULL,
        created_at    TEXT NOT NULL
      );

      CREATE TABLE file_versions (
        id                  TEXT PRIMARY KEY NOT NULL,
        workspace_id        TEXT NOT NULL,
        path                TEXT NOT NULL,
        path_key            TEXT NOT NULL,
        version             INTEGER NOT NULL,
        hash                TEXT NOT NULL,
        size_bytes          INTEGER NOT NULL,
        existed             INTEGER NOT NULL CHECK (existed IN (0, 1)),
        content             BLOB,
        kind                TEXT NOT NULL,
        parent_version      INTEGER,
        mutation_id         TEXT,
        created_by_agent_id TEXT,
        session_id          TEXT,
        room_id             TEXT,
        lock_id             TEXT,
        note                TEXT,
        created_at          TEXT NOT NULL,
        UNIQUE (workspace_id, path_key, version)
      );
      CREATE INDEX file_versions_lookup_idx
        ON file_versions(workspace_id, path_key, version);

      CREATE TABLE file_pending_writes (
        id                  TEXT PRIMARY KEY NOT NULL,
        workspace_id        TEXT NOT NULL,
        path                TEXT NOT NULL,
        path_key            TEXT NOT NULL,
        expected_hash       TEXT NOT NULL,
        previous_existed    INTEGER NOT NULL CHECK (previous_existed IN (0, 1)),
        previous_hash       TEXT NOT NULL,
        previous_content    BLOB,
        next_existed        INTEGER NOT NULL CHECK (next_existed IN (0, 1)),
        next_hash           TEXT NOT NULL,
        next_content        BLOB,
        base_version        INTEGER NOT NULL,
        pre_needed          INTEGER NOT NULL CHECK (pre_needed IN (0, 1)),
        pre_version         INTEGER NOT NULL,
        post_version        INTEGER NOT NULL,
        parent_version      INTEGER,
        kind                TEXT NOT NULL,
        created_by_agent_id TEXT,
        session_id          TEXT,
        room_id             TEXT,
        lock_id             TEXT,
        note                TEXT,
        created_at          TEXT NOT NULL
      );
      CREATE INDEX file_pending_writes_lookup_idx
        ON file_pending_writes(workspace_id, path_key);

      CREATE TABLE ws_checkpoints (
        id                  TEXT PRIMARY KEY NOT NULL,
        workspace_id        TEXT NOT NULL,
        room_id             TEXT NOT NULL,
        created_by_agent_id TEXT NOT NULL,
        status              TEXT NOT NULL CHECK (status IN ('open', 'sealed', 'failed')),
        note                TEXT,
        test_results        TEXT,
        created_at          TEXT NOT NULL,
        sealed_at           TEXT,
        sealed_by_agent_id  TEXT
      );
      CREATE UNIQUE INDEX ws_checkpoints_one_open_idx
        ON ws_checkpoints(workspace_id) WHERE status = 'open';
      CREATE INDEX ws_checkpoints_workspace_idx
        ON ws_checkpoints(workspace_id, created_at);
    `);
  },
};

export const workspaceMigrations: readonly Migration[] = [workspaceCoreMigration] as const;
