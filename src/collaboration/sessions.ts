import {
  asAgentId,
  asIsoDateTime,
  asRoomId,
  asSessionId,
  type PrincipalId,
  type SessionId,
} from "../contracts/index.js";
import type { DatabaseConnection, SqlRow } from "../persistence/index.js";
import { authenticateCollaborationSession, sessionInactiveError } from "./auth.js";
import { appendEvent } from "./events.js";
import { fieldString } from "./rows.js";
import type { HeartbeatResult, LeaveResult, SessionView } from "./types.js";

/** Marca sessoes vencidas como `expired`; usado por leituras de estado. */
export function expireStaleSessions(
  db: DatabaseConnection,
  now: Date,
  roomId?: string,
): void {
  const nowIso = now.toISOString();
  if (roomId === undefined) {
    db.prepare(
      `UPDATE collab_sessions SET status = 'expired'
       WHERE status = 'active' AND expires_at <= ?`,
    ).run(nowIso);
    return;
  }
  db.prepare(
    `UPDATE collab_sessions SET status = 'expired'
     WHERE room_id = ? AND status = 'active' AND expires_at <= ?`,
  ).run(roomId, nowIso);
}

export function getSessionById(
  db: DatabaseConnection,
  sessionId: SessionId,
): SessionView | undefined {
  const row = db.prepare("SELECT * FROM collab_sessions WHERE id = ?").get(sessionId);
  if (row === undefined) return undefined;
  return toSessionView(row);
}

function toSessionView(row: SqlRow): SessionView {
  return {
    id: asSessionId(fieldString(row, "id")),
    roomId: asRoomId(fieldString(row, "room_id")),
    agentId: asAgentId(fieldString(row, "agent_id")),
    status: fieldString(row, "status") as SessionView["status"],
    createdAt: asIsoDateTime(fieldString(row, "created_at")),
    lastHeartbeatAt: asIsoDateTime(fieldString(row, "last_heartbeat_at")),
    expiresAt: asIsoDateTime(fieldString(row, "expires_at")),
    revokedAt:
      row["revoked_at"] === null || row["revoked_at"] === undefined
        ? undefined
        : asIsoDateTime(fieldString(row, "revoked_at")),
  };
}

/**
 * Renovacao ATOMICA: um unico UPDATE condicionado a `status = 'active'` e
 * `expires_at > agora`. Se outra operacao revogou/expirou a sessao no meio,
 * `changes` e 0 e o erro correto e reconstruido pela autenticacao.
 */
export function heartbeatSession(
  db: DatabaseConnection,
  sessionToken: string,
  options: {
    readonly now?: () => Date;
    readonly sessionTtlMs: number;
    readonly principalId: PrincipalId;
  },
): HeartbeatResult {
  const now = (options.now ?? (() => new Date()))();
  const actor = authenticateCollaborationSession(db, sessionToken, {
    now: options.now,
    principalId: options.principalId,
  });

  const nowIso = now.toISOString();
  const renewedUntil = new Date(now.getTime() + options.sessionTtlMs).toISOString();
  const result = db
    .prepare(
      `UPDATE collab_sessions
       SET last_heartbeat_at = ?, expires_at = ?
       WHERE id = ? AND status = 'active' AND expires_at > ?`,
    )
    .run(nowIso, renewedUntil, actor.session.id, nowIso);

  if (result.changes !== 1) {
    // Reconstroi o motivo real (revoked/expired) sem vazar detalhes internos.
    authenticateCollaborationSession(db, sessionToken, {
      now: options.now,
      principalId: options.principalId,
    });
    throw sessionInactiveError("expired");
  }

  const session = getSessionById(db, actor.session.id);
  if (session === undefined) {
    throw sessionInactiveError("invalid");
  }
  return { session, renewedUntil: asIsoDateTime(renewedUntil) };
}

/**
 * Encerra a sessao atual (logout/saida). A associacao do agente com a sala
 * permanece para historico e para eventual novo ingresso via convite; locks
 * futuros deverao expirar pelo heartbeat, nao por este metodo.
 */
export function revokeSession(
  db: DatabaseConnection,
  sessionToken: string,
  options: { readonly now?: () => Date; readonly principalId: PrincipalId },
): LeaveResult {
  const now = (options.now ?? (() => new Date()))();
  const actor = authenticateCollaborationSession(db, sessionToken, {
    now: options.now,
    principalId: options.principalId,
  });
  const revokedAt = now.toISOString();

  db.transaction(() => {
    const updated = db
      .prepare(
        `UPDATE collab_sessions
         SET status = 'revoked', revoked_at = ?
         WHERE id = ? AND status = 'active'`,
      )
      .run(revokedAt, actor.session.id);
    if (updated.changes !== 1) {
      throw sessionInactiveError("revoked");
    }

    appendEvent(db, {
      roomId: actor.room.id,
      type: "session.revoked",
      actorAgentId: actor.agent.id,
      visibility: "room",
      payload: {
        sessionId: String(actor.session.id),
        agentId: String(actor.agent.id),
      },
      createdAt: now.toISOString(),
    });
  });

  return {
    sessionId: actor.session.id,
    status: "revoked",
    revokedAt: asIsoDateTime(revokedAt),
  };
}
