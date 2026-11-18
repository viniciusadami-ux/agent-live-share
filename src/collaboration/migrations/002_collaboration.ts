import type { Migration } from "../../persistence/index.js";

/**
 * Migration 002 — nucleo de colaboracao.
 *
 * Cria as tabelas de agentes, salas, participantes, sessoes, convites,
 * mensagens, solicitacoes, tarefas, dependencias, handoffs, eventos e
 * auditoria. Workspace/locks/versoes/patches pertencem a outra frente
 * (migrations a partir da 10) e NAO sao criados aqui.
 *
 * Regras estruturais relevantes:
 * - `collab_participants.coordinator_slot` e 1 somente para o coordinator
 *   ativo; o indice UNIQUE permite varios NULL (SQLite trata NULLs como
 *   distintos), garantindo no maximo um coordinator por sala.
 * - `collab_sessions.token_hash` e UNIQUE e guarda SOMENTE o SHA-256 do
 *   token; o texto puro nunca e persistido.
 * - `collab_events.cursor` e INTEGER PRIMARY KEY AUTOINCREMENT: monotonico,
 *   global e sem reutilizacao, base do polling por cursor.
 * - `collab_audit_log` nao possui FKs e nao guarda segredos/conteudo.
 */
export const collaborationCoreMigration: Migration = {
  version: 2,
  name: "002_collaboration_core",
  up(db): void {
    db.exec(`
      CREATE TABLE collab_agents (
        id          TEXT PRIMARY KEY NOT NULL,
        display_name TEXT NOT NULL,
        client_kind  TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE collab_rooms (
        id                   TEXT PRIMARY KEY NOT NULL,
        name                 TEXT NOT NULL,
        workspace_id         TEXT NOT NULL,
        coordinator_agent_id TEXT NOT NULL REFERENCES collab_agents(id),
        created_by_agent_id  TEXT NOT NULL REFERENCES collab_agents(id),
        created_at           TEXT NOT NULL
      );
      CREATE INDEX collab_rooms_workspace_idx ON collab_rooms(workspace_id);

      CREATE TABLE collab_participants (
        room_id          TEXT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
        agent_id         TEXT NOT NULL REFERENCES collab_agents(id),
        roles            TEXT NOT NULL,
        active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
        coordinator_slot INTEGER CHECK (coordinator_slot IS NULL OR coordinator_slot = 1),
        joined_at        TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        PRIMARY KEY (room_id, agent_id)
      );
      CREATE UNIQUE INDEX collab_participants_one_coordinator_idx
        ON collab_participants(room_id, coordinator_slot);
      CREATE INDEX collab_participants_agent_idx ON collab_participants(agent_id);

      CREATE TABLE collab_sessions (
        id                TEXT PRIMARY KEY NOT NULL,
        room_id           TEXT NOT NULL,
        agent_id          TEXT NOT NULL,
        token_hash        TEXT NOT NULL UNIQUE,
        status            TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
        created_at        TEXT NOT NULL,
        last_heartbeat_at TEXT NOT NULL,
        expires_at        TEXT NOT NULL,
        revoked_at        TEXT,
        FOREIGN KEY (room_id, agent_id)
          REFERENCES collab_participants(room_id, agent_id)
      );
      CREATE INDEX collab_sessions_room_agent_idx ON collab_sessions(room_id, agent_id);
      CREATE INDEX collab_sessions_status_expiry_idx ON collab_sessions(status, expires_at);

      CREATE TABLE collab_invites (
        id                   TEXT PRIMARY KEY NOT NULL,
        room_id              TEXT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
        token_hash           TEXT NOT NULL UNIQUE,
        roles                TEXT NOT NULL,
        created_by_agent_id  TEXT NOT NULL REFERENCES collab_agents(id),
        created_at           TEXT NOT NULL,
        expires_at           TEXT NOT NULL,
        max_uses             INTEGER NOT NULL CHECK (max_uses >= 1),
        uses                 INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
        revoked_at           TEXT,
        CHECK (uses <= max_uses)
      );
      CREATE INDEX collab_invites_room_idx ON collab_invites(room_id);

      CREATE TABLE collab_messages (
        id             TEXT PRIMARY KEY NOT NULL,
        room_id        TEXT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
        from_agent_id  TEXT NOT NULL REFERENCES collab_agents(id),
        to_agent_id    TEXT REFERENCES collab_agents(id),
        kind           TEXT NOT NULL CHECK (
          kind IN ('chat', 'request', 'response', 'decision', 'progress', 'blocker', 'handoff')
        ),
        correlation_id TEXT,
        body           TEXT NOT NULL,
        payload        TEXT,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX collab_messages_room_created_idx ON collab_messages(room_id, created_at);

      CREATE TABLE collab_requests (
        id                  TEXT PRIMARY KEY NOT NULL,
        room_id             TEXT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
        from_agent_id       TEXT NOT NULL REFERENCES collab_agents(id),
        to_agent_id         TEXT NOT NULL REFERENCES collab_agents(id),
        kind                TEXT NOT NULL CHECK (kind IN ('plan')),
        subject             TEXT NOT NULL,
        details             TEXT,
        status              TEXT NOT NULL CHECK (status IN ('open', 'answered', 'closed')),
        request_message_id  TEXT NOT NULL REFERENCES collab_messages(id),
        response_message_id TEXT REFERENCES collab_messages(id),
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      );
      CREATE INDEX collab_requests_room_status_idx ON collab_requests(room_id, status);

      CREATE TABLE collab_tasks (
        id                  TEXT PRIMARY KEY NOT NULL,
        room_id             TEXT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
        title               TEXT NOT NULL,
        description         TEXT,
        status              TEXT NOT NULL CHECK (
          status IN ('proposed', 'accepted', 'in_progress', 'blocked', 'completed', 'cancelled')
        ),
        assignee_agent_id   TEXT REFERENCES collab_agents(id),
        created_by_agent_id TEXT NOT NULL REFERENCES collab_agents(id),
        blocked_reason      TEXT,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        completed_at        TEXT
      );
      CREATE INDEX collab_tasks_room_status_idx ON collab_tasks(room_id, status);
      CREATE INDEX collab_tasks_room_assignee_idx ON collab_tasks(room_id, assignee_agent_id);

      CREATE TABLE collab_task_dependencies (
        task_id            TEXT NOT NULL REFERENCES collab_tasks(id) ON DELETE CASCADE,
        depends_on_task_id TEXT NOT NULL REFERENCES collab_tasks(id) ON DELETE CASCADE,
        PRIMARY KEY (task_id, depends_on_task_id),
        CHECK (task_id <> depends_on_task_id)
      );

      CREATE TABLE collab_handoffs (
        id                   TEXT PRIMARY KEY NOT NULL,
        room_id              TEXT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
        task_id              TEXT NOT NULL REFERENCES collab_tasks(id) ON DELETE CASCADE,
        from_agent_id        TEXT NOT NULL REFERENCES collab_agents(id),
        objective            TEXT NOT NULL,
        changes              TEXT NOT NULL,
        released_locks       TEXT NOT NULL,
        retained_locks       TEXT NOT NULL,
        tests                TEXT NOT NULL,
        decisions            TEXT NOT NULL,
        known_issues         TEXT NOT NULL,
        reusable             TEXT NOT NULL,
        pending              TEXT NOT NULL,
        next_step            TEXT,
        review_status        TEXT NOT NULL CHECK (
          review_status IN ('not_requested', 'pending', 'approved', 'changes_requested')
        ),
        reviewed_by_agent_id TEXT REFERENCES collab_agents(id),
        review_notes         TEXT,
        reviewed_at          TEXT,
        created_at           TEXT NOT NULL
      );
      CREATE INDEX collab_handoffs_task_created_idx ON collab_handoffs(task_id, created_at);

      CREATE TABLE collab_events (
        cursor          INTEGER PRIMARY KEY AUTOINCREMENT,
        room_id         TEXT NOT NULL REFERENCES collab_rooms(id) ON DELETE CASCADE,
        event_type      TEXT NOT NULL,
        actor_agent_id  TEXT,
        visibility      TEXT NOT NULL CHECK (visibility IN ('room', 'direct', 'self')),
        target_agent_id TEXT,
        message_id      TEXT,
        task_id         TEXT,
        request_id      TEXT,
        handoff_id      TEXT,
        payload         TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        CHECK (visibility <> 'direct' OR target_agent_id IS NOT NULL)
      );
      CREATE INDEX collab_events_room_cursor_idx ON collab_events(room_id, cursor);
      CREATE INDEX collab_events_room_target_idx ON collab_events(room_id, target_agent_id, cursor);

      CREATE TABLE collab_audit_log (
        id             TEXT PRIMARY KEY NOT NULL,
        room_id        TEXT,
        actor_agent_id TEXT,
        session_id     TEXT,
        operation      TEXT NOT NULL,
        outcome        TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'failed')),
        error_code     TEXT,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX collab_audit_log_created_idx ON collab_audit_log(created_at);
    `);
  },
};

export const collaborationMigrations: readonly Migration[] = [collaborationCoreMigration] as const;
